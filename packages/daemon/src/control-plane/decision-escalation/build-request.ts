/**
 * build-request — constructs the full l2-gate `DecisionRequest` the daemon
 * emits when a run parks at the `l2-gate` phase awaiting Operator approval.
 *
 * The output is a COMPLETE object that the REAL `DecisionRequestSchema.parse()`
 * accepts AND `assertFullyClassified()` passes — we validate against the schema
 * itself rather than hand-maintaining a field list (the schema is the gate).
 *
 * SECURITY (§5.1, fail-closed): the control-plane carries NO PHI, so every
 * canonical field is classified `internal` (the non-sensitive operational
 * class). `context`/`question` contain ONLY structured, known-safe text — never
 * `run.l2Feedback`, `run.handoffNotes`, `run.report`, or raw failure messages.
 * Those free-text fields can carry arbitrary worker output and must not be
 * copied verbatim into a request that downstream sinks (dashboard, notifiers)
 * render in plaintext.
 */
import {
  DecisionRequestSchema,
  SENSITIVITY_FIELD_PATHS,
  type DecisionRequest,
  type SensitivityClass,
} from '@auto-claude/decision-protocol';
import type { RunState } from '../../types.js';

/** The phase this builder emits for. */
const L2_GATE_PHASE = 'l2-gate';

/** Default request lifetime when the caller does not pin `expiresAt`. */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Non-sensitive operational class for every field. The sensitivity enum is
 * `public | internal | phi | secret` — there is no `operational` value — so the
 * non-sensitive control-plane class is `internal` (matches the package's own
 * test fixtures).
 */
const OPERATIONAL_CLASS: SensitivityClass = 'internal';

export interface BuildL2GateRequestOpts {
  /** Override the source URL (e.g. a PR url instead of the issue url). */
  sourceUrl?: string;
  /** Override the expiry (ISO 8601). Defaults to `now + 7 days`. */
  expiresAt?: string;
  /** Injectable clock for deterministic tests (ISO 8601). */
  now?: string;
}

/**
 * decisionIdFor — the deterministic decision id. `runRef` is `issue-<n>`, so a
 * given (issue, phase, epoch) always maps to the same id; `observeRequest`
 * dedupes on it across per-tick re-scans.
 */
export function decisionIdFor(runRef: string, phase: string, epoch: number): string {
  return `${runRef}:${phase}:${epoch}`;
}

/** issue-<n> — the deterministic per-issue ref used for `run_id` and the id stem. */
function runRefFor(run: RunState): string {
  return `issue-${run.issueNumber}`;
}

/** Build the issue URL from the run's repo coordinates. */
function issueUrlFor(run: RunState): string {
  const owner = run.repoOwner ?? 'unknown-owner';
  const repo = run.repoName ?? 'unknown-repo';
  return `https://github.com/${owner}/${repo}/issues/${run.issueNumber}`;
}

/**
 * Fully-classified field_sensitivity map: every canonical path -> `internal`.
 * Built from `SENSITIVITY_FIELD_PATHS` (the source of truth `assertFullyClassified`
 * checks) so it can never drift out of sync with the protocol.
 */
function fullSensitivity(): Record<string, SensitivityClass> {
  const map: Record<string, SensitivityClass> = {};
  for (const path of SENSITIVITY_FIELD_PATHS) map[path] = OPERATIONAL_CLASS;
  return map;
}

/**
 * buildL2GateRequest — assemble the complete l2-gate DecisionRequest for a
 * parked run. `epoch` is the run's `decisionEpoch` (bumped on each fresh park),
 * giving a distinct decision per rework cycle. The result is parsed through the
 * real schema so the returned object is guaranteed schema-valid.
 */
export function buildL2GateRequest(
  run: RunState,
  epoch: number,
  deployment: string,
  opts: BuildL2GateRequestOpts = {},
): DecisionRequest {
  const runRef = runRefFor(run);
  const decisionId = decisionIdFor(runRef, L2_GATE_PHASE, epoch);
  const nowIso = opts.now ?? new Date().toISOString();
  const expiresAt =
    opts.expiresAt ?? new Date(new Date(nowIso).getTime() + DEFAULT_EXPIRY_MS).toISOString();

  // Structured, known-safe text only. No run.l2Feedback / handoffNotes / report.
  const context = [
    `Run ${runRef} parked at the ${L2_GATE_PHASE} phase awaiting Operator review.`,
    `Issue #${run.issueNumber} in deployment "${deployment}".`,
    `Pipeline variant: ${run.variant}; decision epoch: ${epoch}.`,
  ].join(' ');

  const request = {
    decision_id: decisionId,
    source_url: opts.sourceUrl ?? issueUrlFor(run),
    deployment,
    run_id: runRef,
    worker_session_id: run.workerClaimId ?? `run-${run.issueNumber}`,
    phase: L2_GATE_PHASE,
    risk_class: 'P1' as const,
    question: `Approve the L2 architecture for issue #${run.issueNumber}?`,
    context,
    options: [
      { id: 'approve', label: 'Approve the L2 architecture and resume the pipeline.' },
      { id: 'reject', label: 'Reject and send back to L2 design for rework.' },
    ],
    consequence_of_no_answer:
      'The run stays parked at the l2-gate phase until an Operator approves or rejects.',
    reversibility: 'reversible' as const,
    expires_at: expiresAt,
    answer_schema: { kind: 'option' as const },
    resume_mode: 'requeue' as const,
    idempotency_key: decisionId,
    field_sensitivity: fullSensitivity(),
    // protocol_version is omitted — the schema defaults it to PROTOCOL_VERSION.
  };

  // Validate against the REAL schema — the schema (not a hand-list) is the gate.
  // `.parse` also applies the protocol_version default, so the returned object
  // is the fully-normalized request.
  return DecisionRequestSchema.parse(request);
}
