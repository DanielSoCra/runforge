// packages/daemon/src/control-plane/merge-decision/build-request.ts
//
// buildMergeDecisionRequest — constructs the full `DecisionRequest` the daemon
// emits when a run PARKS at the `integrate` phase because the merge-decision
// gate returned `escalate` or `hold` (rather than `auto-merge`). It is the merge
// path's sibling to `decision-escalation/build-request.ts`'s buildL2GateRequest
// (the l2-gate authoring-approval request) — SAME shape, SAME schema gate, SAME
// fail-closed sensitivity policy; only the phase, risk_class derivation, options,
// and structured context differ.
//
// STUB — Kimi fills the body. The acceptance contract (build-request.test.ts) is
// IMMOVABLE: the returned object must parse through the REAL DecisionRequestSchema
// AND pass assertFullyClassified (the schema + the canonical-path completeness
// check are the gate — never a hand-maintained field list).
//
// Required behaviour (mirror buildL2GateRequest verbatim except where noted):
//   - phase = 'integrate' (NOT 'l2-gate').
//   - decision_id / idempotency_key = `${runRef}:integrate:${epoch}` where
//     runRef = `issue-<run.issueNumber>` (deterministic; epoch is
//     run.mergeDecisionEpoch — distinct per fresh integrate park).
//   - risk_class = toDecisionRiskClass(decision.effectiveRisk)  ← the ONE place
//     the lane-engine RiskLevel (green..red) maps onto P0..P3. (buildL2GateRequest
//     hardcodes 'P1'; the merge request derives it from the decision.)
//   - run_id = runRef; worker_session_id = run.workerClaimId ?? `run-<n>`.
//   - deployment = the passed `deployment` string (the registry key / `owner/repo`).
//   - source_url = the issue URL from run.repoOwner/run.repoName/run.issueNumber.
//   - field_sensitivity = every canonical SENSITIVITY_FIELD_PATHS entry → 'internal'
//     (the control-plane carries NO PHI — fail-closed, never 'phi'/'secret').
//   - SECURITY: context/question carry ONLY structured, known-safe text — NEVER
//     run.l2Feedback / run.handoffNotes / run.report or raw failure messages, which
//     can carry arbitrary worker output rendered verbatim by downstream sinks.
//   - reversibility = 'reversible'; resume_mode = 'requeue'; answer_schema =
//     { kind: 'option' }; options reflect the escalate/hold disposition (e.g.
//     approve-merge / reject) — at least one option, schema-valid.
//   - Validate the assembled object through DecisionRequestSchema.parse and RETURN
//     the parsed result (so protocol_version is defaulted + the object is normalized).

import {
  DecisionRequestSchema,
  SENSITIVITY_FIELD_PATHS,
  type DecisionRequest,
  type SensitivityClass,
} from '@auto-claude/decision-protocol';
import type { RunState } from '../../types.js';
import type { MergeDecision } from './types.js';
// toDecisionRiskClass is the lane-RiskLevel → P0..P3 mapping; the body MUST use
// it for risk_class. Imported here so the import wiring is part of the gate.
import { toDecisionRiskClass } from './risk-class.js';

/** The phase this builder emits for — the live code-merge seam. */
export const INTEGRATE_PHASE = 'integrate';

/** Default request lifetime when the caller does not pin `expiresAt`. */
export const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface BuildMergeDecisionRequestOpts {
  /** Override the source URL (e.g. a PR url instead of the issue url). */
  sourceUrl?: string;
  /** Override the expiry (ISO 8601). Defaults to `now + 7 days`. */
  expiresAt?: string;
  /** Injectable clock for deterministic tests (ISO 8601). */
  now?: string;
}

/**
 * decisionIdFor — the deterministic merge-decision id, mirroring the l2-gate's
 * `${runRef}:${phase}:${epoch}`. A given (issue, integrate, epoch) always maps to
 * the same id so per-tick re-scans dedupe.
 */
export function decisionIdFor(runRef: string, epoch: number): string {
  return `${runRef}:${INTEGRATE_PHASE}:${epoch}`;
}

/**
 * buildMergeDecisionRequest — assemble the complete integrate-phase
 * DecisionRequest for a run parked by the merge-decision gate. `epoch` is the
 * run's `mergeDecisionEpoch`; `deployment` is the registry key; `decision` is the
 * escalate/hold MergeDecision whose `effectiveRisk` drives `risk_class`.
 */
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
  for (const path of SENSITIVITY_FIELD_PATHS) map[path] = 'internal';
  return map;
}

export function buildMergeDecisionRequest(
  run: RunState,
  epoch: number,
  deployment: string,
  decision: MergeDecision,
  opts: BuildMergeDecisionRequestOpts = {},
): DecisionRequest {
  const runRef = runRefFor(run);
  const decisionId = decisionIdFor(runRef, epoch);
  const nowIso = opts.now ?? new Date().toISOString();
  const expiresAt =
    opts.expiresAt ?? new Date(new Date(nowIso).getTime() + DEFAULT_EXPIRY_MS).toISOString();

  // Structured, known-safe text only. No run.l2Feedback / handoffNotes / report.
  const context = [
    `Run ${runRef} parked at the ${INTEGRATE_PHASE} phase awaiting merge approval.`,
    `Issue #${run.issueNumber} in deployment "${deployment}".`,
    `Pipeline variant: ${run.variant}; decision epoch: ${epoch}.`,
    `Merge disposition: ${decision.kind}; effective risk: ${decision.effectiveRisk}.`,
  ].join(' ');

  const request = {
    decision_id: decisionId,
    source_url: opts.sourceUrl ?? issueUrlFor(run),
    deployment,
    run_id: runRef,
    worker_session_id: run.workerClaimId ?? `run-${run.issueNumber}`,
    phase: INTEGRATE_PHASE,
    risk_class: toDecisionRiskClass(decision.effectiveRisk),
    question: `Approve the merge for issue #${run.issueNumber}?`,
    context,
    // Option ids MUST be {approve, reject}: parseCockpitAnswer recognizes only
    // those literals, and the ledger validates the operator's choice against these
    // stored ids — so the published id, the consumed id, and the answered id all
    // agree end-to-end. (No backward-compat path for a pre-rename `approve-merge`
    // is needed: the integrate resume arm did not exist before this change, so no
    // run was ever parked-then-answered under the old id awaiting a resume.)
    options: [
      { id: 'approve', label: 'Approve the merge and resume the pipeline.' },
      { id: 'reject', label: 'Reject and send back for rework.' },
    ],
    consequence_of_no_answer:
      'The run stays parked at the integrate phase until an Operator approves or rejects.',
    reversibility: 'reversible' as const,
    expires_at: expiresAt,
    answer_schema: { kind: 'option' as const },
    resume_mode: 'requeue' as const,
    idempotency_key: decisionId,
    field_sensitivity: fullSensitivity(),
  };

  return DecisionRequestSchema.parse(request);
}
