/**
 * finding-dismissal/emit.ts — the EMIT side of the finding-dismissal decision
 * flow (PR1): which findings reach the Operator, and the full
 * raise → publish → notify that puts a decision in `/decisions/pending`.
 *
 * This is a PARALLEL emit, reusing the decision-index transport (mirrors the
 * l2-gate emit at `phases.ts:~875`): `ledger.raise(sanitized)` →
 * `GitHubBlockPublisher.ensure()` embeds the block in the issue BODY →
 * `ledger.notify(decision_id)`. The notify is REQUIRED: `/decisions/pending`
 * defaults to `notified/viewed`, so a raise-only row (status `detected`) is
 * filtered out and the Operator never sees it.
 *
 * BOUNDED trigger (no inbox flood): emit ONLY when the issue has a parsed
 * category AND (category ∈ the allowlist OR the issue carries `needs-discussion`).
 * No category → no emit (never train `uncategorized`).
 *
 * IDEMPOTENT (no second OPEN decision): the id is deterministic, and a ledger
 * status check gates re-emit — only a never-raised (`undefined`) or
 * raised-but-not-surfaced (`detected`) row runs the raise/publish/notify; an
 * already-`notified`/answered/terminal row is skipped.
 */
import type { DecisionRequest } from '@runforge/decision-protocol';
import type { ReviewCategory } from '../../coordination/review-scheduler.js';
import type { OctokitLike as PublisherOctokit } from '../decision-escalation/github-block-notifier.js';
import {
  parseCategory,
  hasHumanRoute,
  parseSeverityRiskClass,
  findingDismissalClass,
  isProtectedFinding,
  isRoutineFinding,
} from './labels.js';
import {
  buildFindingDismissalRequest,
  buildFindingDismissalDecisionId,
  type FindingAnswerOptionId,
} from './build-request.js';
import { alertOnNotifyApplied, type DecisionRaisedAlert } from '../decision-alert.js';

/**
 * The fixed emit epoch (PR1). A finding gets ONE decision per (issue, category);
 * the deterministic id makes a per-tick re-scan idempotent. The epoch slot is
 * reserved for a future re-emit cycle (e.g. a PR3 ask-less reset).
 */
export const FINDING_DISMISSAL_EMIT_EPOCH = 1;

/** The narrow ledger surface the emit needs (structurally satisfied by DecisionLedger). */
export interface EmitLedger {
  statusOf(decisionId: string): Promise<string | undefined>;
  /**
   * The STORED recommended_option for an already-raised (immutable) row, or null.
   * On a `detected` re-emit the pre-fill is HYDRATED from this (not recomputed) so the
   * republished block never diverges from the canonical decision row.
   */
  recommendedOptionOf(decisionId: string): Promise<string | null>;
  raise(rawRequest: unknown): Promise<{
    decision_id: string;
    outcome: 'admitted' | 'unchanged' | 'superseded';
  }>;
  notify(decisionId: string): Promise<{ applied: boolean; status: string }>;
}

/** The narrow publisher surface (structurally satisfied by GitHubBlockPublisher). */
export interface EmitPublisher {
  ensure(args: {
    request: DecisionRequest;
    octokit: PublisherOctokit;
    owner: string;
    repo: string;
    issueNumber: number;
  }): Promise<{ posted: boolean; reason?: string }>;
}

/**
 * The narrow operator-learning surface the EMIT consults for the rung-2 pre-fill
 * (structurally satisfied by OperatorLearningService). Distinct from the CONSUMER's
 * `ConsumerLearning` (which observes answers) — the emit only READS the preference.
 */
export interface EmitLearning {
  getPreference(
    decisionClass: string,
    context: string,
  ): Promise<{
    // The learning rung is a fixed 3-value ladder — typing it (not `string`) makes the
    // pre-fill gate exhaustive: only `pre-fill`/`propose-ask-less` earn a recommendation.
    rung: 'surface' | 'pre-fill' | 'propose-ask-less';
    mostFrequentChoice?: string;
    confidence: number;
  }>;
}

/** Statuses past which the decision is already surfaced/decided — re-emit is skipped. */
const REEMIT_OK_STATUSES: ReadonlySet<string> = new Set(['detected']);

/**
 * The valid finding-dismissal answer option ids. A pre-fill is accepted ONLY when
 * the learned `mostFrequentChoice` is one of these (F3 defense-in-depth: never
 * pre-fill an off-menu / stale choice onto the request).
 */
const OPTION_IDS: ReadonlySet<FindingAnswerOptionId> = new Set(['approve', 'reject']);

/** Type guard: is a learned `mostFrequentChoice` a valid on-menu option id? */
function isFindingAnswerOptionId(x: string): x is FindingAnswerOptionId {
  return (OPTION_IDS as ReadonlySet<string>).has(x);
}

/** The rung-2 pre-fill pair — recommendation + its reason are always both present or neither. */
type EmitPrefill = { recommendedOption?: FindingAnswerOptionId; recommendedReason?: string };

/**
 * buildRecommendedReason — the structured, allowlisted reason shown on the recommended
 * option's `detail` (never finding free-text). `confidencePct` is appended only on a
 * fresh compute (a `detected`-retry hydrate has no stored confidence and omits it).
 */
function buildRecommendedReason(option: FindingAnswerOptionId, confidencePct?: number): string {
  const verb = option === 'approve' ? 'keep' : 'dismiss';
  const conf = confidencePct !== undefined ? ` (confidence ${confidencePct}%)` : '';
  return `Recommended: ${verb} — learned from your consistent prior decisions in this category${conf}.`;
}

/**
 * computeFindingPrefill — the rung-2 pre-fill decision, FAIL-OPEN. Consults the
 * learned preference and returns `{recommendedOption, recommendedReason}` ONLY when
 * the class has EARNED a pre-fill (rung !== 'surface') AND the learned choice is a
 * valid on-menu option id. Guarded categories (e.g. `finding_dismissal:security`)
 * are auto-capped at `surface` by the preference engine → excluded by the rung gate.
 *
 * PROTECTION GATE (PR3-pre, codex R2 CRIT-3 — closes the live PR2 gap): FIRST, if
 * the finding is PROTECTED (`isProtectedFinding(labels)` — a guarded category, a
 * human-route/protection label, OR an uncertain/critical severity) OR NOVEL
 * (`!isRoutineFinding(labels)` — any label outside the routine vocabulary, #819),
 * return NO pre-fill unconditionally. A P0/compliance/sensitive/novel finding must
 * never receive a pre-filled dismiss recommendation, regardless of how strong the
 * learned pattern is. This is fail-CLOSED and takes precedence over the fail-open
 * learning read, and aligns rung-2 nudging with the L1 v2 fourth-rung guardrail
 * (novel is never auto-acted on — here it is not even nudged).
 *
 * ANY error (a learning read failure) is caught, logged, and treated as NO pre-fill —
 * the emit must never drop a decision because the best-effort hint failed (L1
 * operator-learning: learning never suppresses a decision). Returns an empty object
 * on no-prefill / error; the builder then produces the plain PR1 shape.
 */
async function computeFindingPrefill(
  operatorLearning: EmitLearning,
  category: ReviewCategory,
  owner: string,
  repo: string,
  issueNumber: number,
  labels: readonly string[],
): Promise<{ recommendedOption?: FindingAnswerOptionId; recommendedReason?: string }> {
  // PR3-pre protection gate (+ #819 novelty gate): a protected/uncertain-severity
  // OR novel (non-routine-vocabulary) finding is NEVER pre-filled — the Operator
  // decides it explicitly. Checked before the learning read so no strong pattern
  // can override it.
  if (isProtectedFinding(labels) || !isRoutineFinding(labels)) return {};
  try {
    const pref = await operatorLearning.getPreference(findingDismissalClass(category), `${owner}/${repo}`);
    const choice = pref.mostFrequentChoice;
    if (pref.rung === 'surface' || choice === undefined || !isFindingAnswerOptionId(choice)) {
      return {};
    }
    // `choice` is narrowed to FindingAnswerOptionId by the guard above.
    const recommendedOption = choice;
    // confidence is a 0..1 fraction (Preference.confidence: z.number().min(0).max(1)).
    const confidencePct = Math.round(pref.confidence * 100);
    return { recommendedOption, recommendedReason: buildRecommendedReason(recommendedOption, confidencePct) };
  } catch (e) {
    // FAIL-OPEN: never let a learning read error suppress the decision.
    console.warn(
      `[finding-dismissal] pre-fill lookup failed for #${issueNumber} (${category}) — raising with no pre-fill: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}

/**
 * resolveEmitPrefill — pick the pre-fill to publish, keyed on the row status.
 *
 * A `detected` row was ALREADY raised (its request is IMMUTABLE per decision_id — a
 * finding request carries no `source_etag`, so a re-raise is observed as `unchanged` and
 * NEVER rewrites the stored row): a later retry recomputing the pre-fill from a
 * since-drifted preference would publish a GitHub block whose `recommended_option`
 * diverges from the stored decision row — and the dashboard, `recommendedOptionOf()`, and
 * `matchedRecommendation` all read the STORED row, so the block would lie. On a `detected`
 * retry we therefore MIRROR the stored row (no recompute → no drift). Only a first raise
 * (`status === undefined`) computes fresh.
 *
 * CONTRACT (canonical pre-fill): the STORED `recommended_option` is the single
 * load-bearing value (it drives `matchedRecommendation`); the reason `detail` is
 * presentation only. On a retry the reason is rebuilt WITHOUT the original confidence (it
 * is not stored) — a cosmetic difference that never affects the load-bearing value.
 *
 * FAIL-CLOSED on the retry read (codex): if the stored read THROWS we do NOT synthesize a
 * no-pre-fill block (that would diverge from a stored row that may hold a recommendation,
 * with no etag to self-correct). We signal `hydrateFailed` so the caller SKIPS publishing
 * this tick and retries next tick — the row is already durably raised, so no decision is
 * lost, and the read shares the store with the just-succeeded `statusOf`, so the failure
 * is transient. (A first raise stays fail-OPEN: learning never suppresses the raise.)
 */
async function resolveEmitPrefill(
  status: string | undefined,
  ledger: EmitLedger,
  operatorLearning: EmitLearning,
  decisionId: string,
  category: ReviewCategory,
  owner: string,
  repo: string,
  issueNumber: number,
  labels: readonly string[],
): Promise<{ prefill: EmitPrefill } | { hydrateFailed: true }> {
  if (status === undefined) {
    return { prefill: await computeFindingPrefill(operatorLearning, category, owner, repo, issueNumber, labels) };
  }
  // `detected` retry: mirror the stored row exactly (no recompute → no drift).
  let stored: string | null;
  try {
    stored = await ledger.recommendedOptionOf(decisionId);
  } catch (e) {
    console.warn(
      `[finding-dismissal] stored pre-fill read failed on retry for ${decisionId} (skipping publish this tick, will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
    return { hydrateFailed: true };
  }
  if (stored !== null && isFindingAnswerOptionId(stored)) {
    return { prefill: { recommendedOption: stored, recommendedReason: buildRecommendedReason(stored) } };
  }
  return { prefill: {} };
}

/**
 * shouldEmitFindingDismissal — the pure trigger predicate. Returns the parsed
 * category (or null) and whether it should emit (allowlist OR needs-discussion).
 */
export function shouldEmitFindingDismissal(
  labels: readonly string[],
  allowlist: readonly string[],
): { emit: boolean; category: ReviewCategory | null } {
  const category = parseCategory(labels);
  if (category === null) return { emit: false, category: null };
  const emit = allowlist.includes(category) || hasHumanRoute(labels);
  return { emit, category };
}

export interface EmitFindingDismissalArgs {
  ledger: EmitLedger;
  /** Consulted (fail-open) for the rung-2 pre-fill recommendation. */
  operatorLearning: EmitLearning;
  publisher: EmitPublisher;
  octokit: PublisherOctokit;
  owner: string;
  repo: string;
  issueNumber: number;
  category: ReviewCategory;
  riskClass: ReturnType<typeof parseSeverityRiskClass>;
  /**
   * The finding's raw issue labels — threaded into the pre-fill protection gate
   * (`isProtectedFinding` + `isRoutineFinding`, #819). A protected/uncertain-severity
   * OR novel (non-routine-vocabulary) finding gets NO pre-fill (PR3-pre, closes the
   * PR2 gap). Distinct from `riskClass` (which fills the request and fail-OPEN
   * defaults to P2); the gate reads severity fail-CLOSED from these.
   */
  labels: readonly string[];
  /** Defaults to FINDING_DISMISSAL_EMIT_EPOCH. */
  epoch?: number;
  /** Input-boundary sanitizer (defaults to identity). Mirrors the gate emit. */
  sanitize?: (request: DecisionRequest) => Promise<DecisionRequest>;
  now?: string;
  /** Optional dashboard base URL for the decision-raised alert deep link. */
  dashboardBaseUrl?: string;
  /** Optional operator alert callback for the decision-raised event. */
  alert?: DecisionRaisedAlert;
}

export interface EmitResult {
  emitted: boolean;
  decisionId: string;
  reason: string;
}

/**
 * emitFindingDismissalDecision — the single-finding raise → publish → notify with
 * the idempotency status gate. Fail-closed: a non-posted publish leaves the row
 * un-notified (caller retries next tick); the function never throws on a
 * publish/ledger no-op (it returns a reason).
 */
export async function emitFindingDismissalDecision(
  args: EmitFindingDismissalArgs,
  positionalAlert?: DecisionRaisedAlert,
): Promise<EmitResult> {
  const {
    ledger,
    operatorLearning,
    publisher,
    octokit,
    owner,
    repo,
    issueNumber,
    category,
    riskClass,
    alert,
    dashboardBaseUrl,
  } = args;
  const effectiveAlert = positionalAlert ?? alert;
  const epoch = args.epoch ?? FINDING_DISMISSAL_EMIT_EPOCH;
  const sanitize = args.sanitize ?? (async (r: DecisionRequest) => r);
  const decisionId = buildFindingDismissalDecisionId(owner, repo, issueNumber, category, epoch);

  // IDEMPOTENT status gate: only emit when never raised (undefined) or raised but
  // not yet surfaced (detected). An already-notified/answered/terminal row is the
  // SAME decision — never a second OPEN one.
  const status = await ledger.statusOf(decisionId);
  if (status !== undefined && !REEMIT_OK_STATUSES.has(status)) {
    return { emitted: false, decisionId, reason: `already:${status}` };
  }

  // RUNG-2 pre-fill (fail-open): a FIRST raise computes the recommendation from the
  // learned preference; a `detected` retry hydrates it from the immutable stored row so
  // the republished block never diverges from it. Both swallow read errors internally —
  // a throw must NEVER reach scanAndEmit's per-finding catch (which SKIPs the finding,
  // suppressing the decision). Guarded categories never earn a pre-fill.
  const prefillResult = await resolveEmitPrefill(
    status,
    ledger,
    operatorLearning,
    decisionId,
    category,
    owner,
    repo,
    issueNumber,
    args.labels,
  );
  if ('hydrateFailed' in prefillResult) {
    // A `detected` retry whose stored pre-fill read threw: do NOT publish a synthesized
    // block (it could diverge from the immutable stored row). The row is already durably
    // raised — skip this tick; the next tick retries with a fresh read.
    return { emitted: false, decisionId, reason: 'prefill_hydrate_failed' };
  }
  const { recommendedOption, recommendedReason } = prefillResult.prefill;

  const request = buildFindingDismissalRequest({
    issueNumber,
    category,
    owner,
    repo,
    riskClass,
    epoch,
    now: args.now,
    recommendedOption,
    recommendedReason,
  });
  const sanitized = await sanitize(request);
  const raised = await ledger.raise(sanitized);
  // FIRST-RAISE RACE (codex): we computed a FRESH pre-fill (status was undefined), but
  // raise reports the row already existed (`unchanged`/`superseded`) — a concurrent emitter
  // admitted the canonical row first. `raise` NEVER rewrites an existing row (a finding has
  // no `source_etag`), so our freshly-built request may carry a DIFFERENT pre-fill than what
  // was stored; publishing it would embed a block that diverges from the stored decision row
  // (which the dashboard, `recommendedOptionOf()`, and `matchedRecommendation` all read).
  // Skip publishing this tick: the winner (or a later `detected`-retry tick, which hydrates
  // the stored pre-fill) surfaces the canonical block. The `detected`-retry path already
  // hydrated its request from the stored row before building, so its `unchanged` is safe and
  // is intentionally NOT skipped here (status !== undefined).
  if (status === undefined && raised.outcome !== 'admitted') {
    return { emitted: false, decisionId: raised.decision_id, reason: `raced:${raised.outcome}` };
  }
  const published = await publisher.ensure({
    request: sanitized,
    octokit,
    owner,
    repo,
    issueNumber,
  });
  if (!published.posted) {
    return { emitted: false, decisionId: raised.decision_id, reason: `publish:${published.reason ?? 'unknown'}` };
  }
  const notified = await alertOnNotifyApplied(
    () => ledger.notify(raised.decision_id),
    effectiveAlert,
    {
      issueNumber,
      decisionId: raised.decision_id,
      title: sanitized.question,
      dashboardBaseUrl,
    },
  );
  return { emitted: true, decisionId: raised.decision_id, reason: `notified:${notified.status}` };
}

/** A review-finding issue as the scan sees it (number + its labels). */
export interface ReviewFindingIssue {
  issueNumber: number;
  labels: string[];
}

export interface ScanAndEmitArgs {
  /** Lists OPEN `review-finding` issues with their labels (wraps octokit.issues.listForRepo). */
  listReviewFindings: () => Promise<ReviewFindingIssue[]>;
  allowlist: readonly string[];
  ledger: EmitLedger;
  /** Consulted (fail-open) for the rung-2 pre-fill recommendation. */
  operatorLearning: EmitLearning;
  publisher: EmitPublisher;
  octokit: PublisherOctokit;
  owner: string;
  repo: string;
  sanitize?: (request: DecisionRequest) => Promise<DecisionRequest>;
  now?: string;
  /** Optional dashboard base URL for the decision-raised alert deep link. */
  dashboardBaseUrl?: string;
  /** Optional operator alert callback for the decision-raised event. */
  alert?: DecisionRaisedAlert;
}

/**
 * scanAndEmitFindingDismissals — the tick-side scan: list open review-finding
 * issues, apply the bounded trigger, and emit a finding-dismissal decision for
 * each eligible finding. Per-finding failures are isolated (one bad issue never
 * aborts the scan). Returns the per-issue emit results (for logging/tests).
 */
export async function scanAndEmitFindingDismissals(
  args: ScanAndEmitArgs,
): Promise<EmitResult[]> {
  const findings = await args.listReviewFindings();
  const results: EmitResult[] = [];
  for (const finding of findings) {
    const { emit, category } = shouldEmitFindingDismissal(finding.labels, args.allowlist);
    if (!emit || category === null) continue;
    try {
      const result = await emitFindingDismissalDecision({
        ledger: args.ledger,
        operatorLearning: args.operatorLearning,
        publisher: args.publisher,
        octokit: args.octokit,
        owner: args.owner,
        repo: args.repo,
        issueNumber: finding.issueNumber,
        category,
        riskClass: parseSeverityRiskClass(finding.labels),
        labels: finding.labels,
        sanitize: args.sanitize,
        now: args.now,
        dashboardBaseUrl: args.dashboardBaseUrl,
        alert: args.alert,
      });
      results.push(result);
    } catch (e) {
      console.warn(
        `[finding-dismissal] emit failed for #${finding.issueNumber} (continuing): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return results;
}
