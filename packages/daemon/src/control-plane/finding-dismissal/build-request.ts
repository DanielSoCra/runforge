/**
 * finding-dismissal/build-request.ts — the issue-level DecisionRequest builder
 * for the finding-dismissal decision flow (PR1). The sibling of
 * `decision-escalation/build-request.ts` (l2-gate) and
 * `merge-decision/build-request.ts` (integrate) — SAME schema gate, only the
 * phase / id shape / options / source differ.
 *
 * A finding is a GitHub **issue**, not a parked run. So the request carries a
 * **synthetic, repo-scoped `run_id`** (`finding-<owner>/<repo>#<issue>`) and a
 * documented synthetic `worker_session_id` — there is NO real worker session. The
 * apply-consumer is the ONLY thing that processes these rows
 * (`resumeParkedRuns` never sees them: it iterates parked RunState, and a finding
 * has none).
 *
 * THE CARRIER OF PHASE + CATEGORY IS THE `decision_id` (codex CRITICAL-2): the
 * ledger facade does not expose `phase`, and `deriveLearningKey` receives only
 * `decision_id` + `source_url`. So the id is STRICT and machine-readable:
 *   `finding-<owner>/<repo>#<issue>:finding-dismissal:<category>:<epoch>`
 * The `<owner>/<repo>` namespace makes the id REPO-SCOPED — in a multi-repo
 * daemon, the same issue#/category/epoch in two repos yields DISTINCT ids, so the
 * emit's status-check never sees the OTHER repo's row and suppresses a valid
 * decision. `<owner>/<repo>` and `<issue>` carry no `:`, so the id still splits
 * into exactly 4 colon-segments and `deriveLearningKey`'s `split(':')[1]` is the
 * phase. Every downstream parse (consumer filter, learning-key derivation) keys
 * off this id.
 *
 * The built object is validated through the REAL `DecisionRequestSchema` (the
 * schema IS the gate — never a hand-maintained field list).
 */
import {
  DecisionRequestSchema,
  type DecisionRequest,
  type RiskClass,
} from '@auto-claude/decision-protocol';
import type { ReviewCategory } from '../../coordination/review-scheduler.js';
import { isReviewCategory } from './labels.js';

/** The phase this builder emits for — the issue-level finding-dismissal seam. */
export const FINDING_DISMISSAL_PHASE = 'finding-dismissal';

/** Default request lifetime when the caller does not pin `expiresAt`. */
export const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The binary answer options. `approve` = keep the finding; `reject` = dismiss it. */
export const KEEP_OPTION = { id: 'approve', label: 'Keep the finding' } as const;
export const DISMISS_OPTION = { id: 'reject', label: 'Dismiss the finding' } as const;

/**
 * The valid on-menu answer option ids. Narrowing `recommendedOption` to this union
 * (not raw `string`) closes the builder-API type hole (codex): a direct caller can
 * only ever pre-fill a real option — never a bogus/off-menu `recommended_option`.
 */
export type FindingAnswerOptionId = typeof KEEP_OPTION.id | typeof DISMISS_OPTION.id;

/**
 * findingRunRef — the synthetic, REPO-SCOPED run ref + id stem for a finding:
 * `finding-<owner>/<repo>#<issue>`. A finding has no real run; this never
 * collides with a real `issue-<n>` run ref, and the `<owner>/<repo>` namespace
 * disambiguates the same issue number across repos.
 */
export function findingRunRef(owner: string, repo: string, issueNumber: number): string {
  return `finding-${owner}/${repo}#${issueNumber}`;
}

/**
 * buildFindingDismissalDecisionId — the STRICT deterministic, REPO-SCOPED id
 * `finding-<owner>/<repo>#<issue>:finding-dismissal:<category>:<epoch>`. A given
 * (owner, repo, issue, category, epoch) always maps to the same id, so a per-tick
 * re-emit dedupes (raise is idempotent on the id) and the consumer filters on it.
 */
export function buildFindingDismissalDecisionId(
  owner: string,
  repo: string,
  issueNumber: number,
  category: ReviewCategory,
  epoch: number,
): string {
  return `${findingRunRef(owner, repo, issueNumber)}:${FINDING_DISMISSAL_PHASE}:${category}:${epoch}`;
}

/** The parsed parts of a finding-dismissal decision id. */
export interface ParsedFindingDismissalId {
  owner: string;
  repo: string;
  issueNumber: number;
  category: ReviewCategory;
  epoch: number;
}

/**
 * parseFindingDismissalDecisionId — the inverse of the builder, used by the
 * consumer filter AND `deriveLearningKey`. STRICT: returns `null` for any id that
 * is not exactly `finding-<owner>/<repo>#<n>:finding-dismissal:<category>:<epoch>`
 * with non-empty `<owner>`/`<repo>`, a numeric `<n>`, a recognized `<category>`,
 * and a numeric `<epoch>`. Never throws, never mis-keys (a malformed/short id →
 * neutral).
 */
export function parseFindingDismissalDecisionId(
  decisionId: string,
): ParsedFindingDismissalId | null {
  const parts = decisionId.split(':');
  if (parts.length !== 4) return null;
  const [stem, phase, category, epochRaw] = parts as [string, string, string, string];
  if (phase !== FINDING_DISMISSAL_PHASE) return null;
  if (!stem.startsWith('finding-')) return null;
  // stem body = `<owner>/<repo>#<issue>`
  const body = stem.slice('finding-'.length);
  const hashIdx = body.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const repoFull = body.slice(0, hashIdx);
  const issueRaw = body.slice(hashIdx + 1);
  if (!/^\d+$/.test(issueRaw)) return null;
  const slashIdx = repoFull.indexOf('/');
  if (slashIdx <= 0) return null;
  const owner = repoFull.slice(0, slashIdx);
  const repo = repoFull.slice(slashIdx + 1);
  if (owner.length === 0 || repo.length === 0 || repo.includes('/')) return null;
  if (!isReviewCategory(category)) return null;
  if (!/^\d+$/.test(epochRaw)) return null;
  return {
    owner,
    repo,
    issueNumber: Number(issueRaw),
    category,
    epoch: Number(epochRaw),
  };
}

/** Cheap predicate: is this decision id a finding-dismissal id? (consumer filter). */
export function isFindingDismissalDecisionId(decisionId: string): boolean {
  return decisionId.includes(`:${FINDING_DISMISSAL_PHASE}:`);
}

/** The GitHub issue URL for a finding in `owner/repo`. */
export function findingIssueUrl(owner: string, repo: string, issueNumber: number): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

export interface BuildFindingDismissalRequestArgs {
  issueNumber: number;
  category: ReviewCategory;
  owner: string;
  repo: string;
  /** Severity-derived risk class (P0..P3). */
  riskClass: RiskClass;
  /** Deterministic emit epoch (stable per finding so the id dedupes across ticks). */
  epoch: number;
  /** Override the source URL (defaults to the issue URL). */
  sourceUrl?: string;
  /** Override the expiry (ISO 8601). Defaults to `now + 7 days`. */
  expiresAt?: string;
  /** Injectable clock for deterministic tests (ISO 8601). */
  now?: string;
  /**
   * PR2 rung-2 pre-fill: the learned recommended option id (`approve`/`reject`).
   * When present, the request carries `recommended_option` AND the matching option
   * gets `recommendedReason` on its `detail`. Absent → the PR1 (rung-1) shape,
   * byte-identical to before (no `recommended_option`, no option `detail`).
   */
  recommendedOption?: FindingAnswerOptionId;
  /** The structured, allowlisted reason shown on the recommended option's `detail`. */
  recommendedReason?: string;
}

/**
 * buildFindingDismissalRequest — assemble the COMPLETE finding-dismissal
 * DecisionRequest and validate it through `DecisionRequestSchema.parse` (which
 * defaults `protocol_version` and normalizes the object).
 *
 * `recommended_option` is set ONLY when the caller passes a rung-2 `recommendedOption`
 * (PR2 pre-fill); the matching option then carries the structured `recommendedReason`
 * on its `detail`. With no pre-fill the output is byte-identical to the PR1 (rung-1)
 * shape — no `recommended_option`, no option `detail`. Guarded categories never
 * reach here with a pre-fill (the emit's rung gate excludes them).
 *
 * SECURITY: `context`/`question` carry ONLY structured, known-safe text — never
 * finding free-text (titles/bodies can carry arbitrary content rendered verbatim
 * by downstream sinks). The `recommendedReason` is likewise a structured, allowlisted
 * string composed by the caller (never finding free-text). The decision detail links
 * back to the issue via `source_url`.
 */
export function buildFindingDismissalRequest(
  args: BuildFindingDismissalRequestArgs,
): DecisionRequest {
  const { issueNumber, category, owner, repo, riskClass, epoch, recommendedOption, recommendedReason } = args;
  const decisionId = buildFindingDismissalDecisionId(owner, repo, issueNumber, category, epoch);
  const deployment = `${owner}/${repo}`;
  const nowIso = args.now ?? new Date().toISOString();
  const expiresAt =
    args.expiresAt ?? new Date(new Date(nowIso).getTime() + DEFAULT_EXPIRY_MS).toISOString();

  const context = [
    `Review finding #${issueNumber} in ${deployment} is awaiting an Operator keep/dismiss decision.`,
    `Finding category: ${category}; severity risk class: ${riskClass}.`,
    `Keep retains the finding on the autonomous triage path; dismiss closes it out.`,
  ].join(' ');

  // PR2 rung-2 pre-fill: attach the structured reason to the RECOMMENDED option's
  // `detail`. With no pre-fill each option stays `{id,label}` — byte-identical to
  // PR1 (the conditional key spread never adds an undefined `detail`).
  const options = [KEEP_OPTION, DISMISS_OPTION].map((o) =>
    recommendedOption !== undefined && recommendedReason !== undefined && o.id === recommendedOption
      ? { id: o.id, label: o.label, detail: recommendedReason }
      : { id: o.id, label: o.label },
  );

  const request = {
    decision_id: decisionId,
    source_url: args.sourceUrl ?? findingIssueUrl(owner, repo, issueNumber),
    deployment,
    // Synthetic, repo-scoped run_id: a finding has NO real run.
    // `finding-<owner>/<repo>#<issue>` documents that, never collides with a real
    // `issue-<n>` run ref, and is never matched by resumeParkedRuns (which keys on
    // parked RunState, not on run_id strings).
    run_id: findingRunRef(owner, repo, issueNumber),
    worker_session_id: `finding-dismissal-${issueNumber}`,
    phase: FINDING_DISMISSAL_PHASE,
    risk_class: riskClass,
    question: `Keep or dismiss review finding #${issueNumber} (${category})?`,
    context,
    options,
    // recommended_option is set ONLY for a rung-2 pre-fill (PR2), and ONLY together with
    // its reason (`recommendedReason` on the option `detail`) — both-or-neither, so a
    // pre-fill is never shown without the reason the rung-2 contract requires (a typed
    // caller passing only one is treated as no pre-fill). Guarded categories never reach
    // here with one (the emit rung gate excludes them). Absent → omitted (PR1 shape).
    ...(recommendedOption !== undefined && recommendedReason !== undefined
      ? { recommended_option: recommendedOption }
      : {}),
    consequence_of_no_answer:
      'The finding stays open and surfaced until the Operator keeps or dismisses it.',
    reversibility: 'reversible' as const,
    expires_at: expiresAt,
    answer_schema: { kind: 'option' as const },
    resume_mode: 'requeue' as const,
    idempotency_key: decisionId,
  };

  return DecisionRequestSchema.parse(request);
}
