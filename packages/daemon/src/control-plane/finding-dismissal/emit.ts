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
import type { DecisionRequest } from '@auto-claude/decision-protocol';
import type { ReviewCategory } from '../../coordination/review-scheduler.js';
import type { OctokitLike as PublisherOctokit } from '../decision-escalation/github-block-notifier.js';
import {
  parseCategory,
  hasHumanRoute,
  parseSeverityRiskClass,
} from './labels.js';
import {
  buildFindingDismissalRequest,
  buildFindingDismissalDecisionId,
} from './build-request.js';

/**
 * The fixed emit epoch (PR1). A finding gets ONE decision per (issue, category);
 * the deterministic id makes a per-tick re-scan idempotent. The epoch slot is
 * reserved for a future re-emit cycle (e.g. a PR3 ask-less reset).
 */
export const FINDING_DISMISSAL_EMIT_EPOCH = 1;

/** The narrow ledger surface the emit needs (structurally satisfied by DecisionLedger). */
export interface EmitLedger {
  statusOf(decisionId: string): Promise<string | undefined>;
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

/** Statuses past which the decision is already surfaced/decided — re-emit is skipped. */
const REEMIT_OK_STATUSES: ReadonlySet<string> = new Set(['detected']);

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
  publisher: EmitPublisher;
  octokit: PublisherOctokit;
  owner: string;
  repo: string;
  issueNumber: number;
  category: ReviewCategory;
  riskClass: ReturnType<typeof parseSeverityRiskClass>;
  /** Defaults to FINDING_DISMISSAL_EMIT_EPOCH. */
  epoch?: number;
  /** Input-boundary sanitizer (defaults to identity). Mirrors the gate emit. */
  sanitize?: (request: DecisionRequest) => Promise<DecisionRequest>;
  now?: string;
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
): Promise<EmitResult> {
  const {
    ledger,
    publisher,
    octokit,
    owner,
    repo,
    issueNumber,
    category,
    riskClass,
  } = args;
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

  const request = buildFindingDismissalRequest({
    issueNumber,
    category,
    owner,
    repo,
    riskClass,
    epoch,
    now: args.now,
  });
  const sanitized = await sanitize(request);
  const raised = await ledger.raise(sanitized);
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
  const notified = await ledger.notify(raised.decision_id);
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
  publisher: EmitPublisher;
  octokit: PublisherOctokit;
  owner: string;
  repo: string;
  sanitize?: (request: DecisionRequest) => Promise<DecisionRequest>;
  now?: string;
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
        publisher: args.publisher,
        octokit: args.octokit,
        owner: args.owner,
        repo: args.repo,
        issueNumber: finding.issueNumber,
        category,
        riskClass: parseSeverityRiskClass(finding.labels),
        sanitize: args.sanitize,
        now: args.now,
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
