/**
 * STACK-AC-CONTROL-PLANE — the Operator-triggered `POST /retry/:issue` handler.
 *
 * Realizes the FUNC-AC-PIPELINE scenario "Operator retries a stuck request":
 * resets a `stuck` work request and re-admits it FROM SCRATCH (as a new work
 * request) without manual GitHub label surgery. The route adapter in `server.ts`
 * pipes the returned `{ status, body }` straight to `json(res, …)`; the daemon
 * wiring (`daemon.ts`) supplies the live octokit + in-memory/run-state hooks.
 *
 * The handler is pure-ish over its injected deps (octokit + state hooks) so the
 * full admission + reset matrix is unit-testable WITHOUT GitHub or Postgres.
 *
 * ── Admission (ORDER MATTERS) ────────────────────────────────────────────────
 * The per-issue auto-cap adds `blocked` WITHOUT `stuck` (daemon.ts), so `blocked`
 * is checked BEFORE "not stuck":
 *   1. has `blocked` (auto-capped OR manual) → 409 (budget-reset is a follow-up).
 *   2. awaiting an Operator decision (`decision-request` label, or an active
 *      `l2-gate`/`integrate` decision park) → 409 (answer the decision instead).
 *   3. not `stuck` → 404.
 *   4. else (`stuck`, not blocked, not a decision) → proceed.
 *
 * ── From-scratch reset (DURABLE-FIRST) ───────────────────────────────────────
 * Internal, recoverable cleanup runs BEFORE the externally-visible label change,
 * so a mid-failure leaves the item visibly `stuck` (human-required), never
 * half-reset:
 *   1. In-memory ONLY (no GitHub): clear the `stuckBackoff` entry, the in-memory
 *      claim tracking, and the persisted parked/partial run state so detection
 *      starts a NEW run (never a resume). `releaseClaim` is deliberately NOT
 *      called — it removes GitHub labels (incl. `l2-in-progress`, a real tier).
 *      Any failure here → 503, NO GitHub touched.
 *   2. GitHub mutations, strand-safe order:
 *      (a) ADD the restored ENTRY label FIRST (detectable the instant `stuck`
 *          goes), by work type.
 *      (b) strip the leftover cockpit decision body-block (fail-closed on
 *          ambiguous markers; no-op if absent).
 *      (c) remove the stale active/claim labels (404 tolerated).
 *      (d) remove `stuck` LAST — only then is the item re-admitted.
 *      Any failure before (d) leaves `stuck`+entry (still excluded → safe).
 *   3. Best-effort audit comment (must NOT fail the already-completed retry).
 */
import type { HandlerResult, ErrorBody } from './decision-api.js';
import {
  inferRetryRestoration,
  type RetryRestorationPlan,
} from './work-detection.js';
import {
  BLOCK_START,
  BLOCK_END,
} from './decision-escalation/github-block-notifier.js';

/** Narrow octokit issues surface the retry handler needs (keeps it testable). */
export interface RetryIssuesApi {
  get(args: { owner: string; repo: string; issue_number: number }): Promise<{
    data: { body?: string | null; labels?: Array<string | { name?: string | null }> };
  }>;
  addLabels(args: {
    owner: string;
    repo: string;
    issue_number: number;
    labels: string[];
  }): Promise<unknown>;
  removeLabel(args: {
    owner: string;
    repo: string;
    issue_number: number;
    name: string;
  }): Promise<unknown>;
  update(args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<unknown>;
  createComment(args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<unknown>;
}

export interface RetryOctokit {
  issues: RetryIssuesApi;
}

/** A parked run, narrowed to what the decision-park admission check needs. */
export interface ParkedRunInfo {
  issueNumber: number;
  pausedAtPhase?: string;
}

/** Everything the handler injects, so it never binds GitHub/Postgres directly. */
export interface OperatorRetryDeps {
  octokit: RetryOctokit;
  owner: string;
  repo: string;
  /** Clear the in-memory backoff entry for this issue (no GitHub). */
  clearBackoff: (issueNumber: number) => void;
  /** Clear the in-memory active/claim tracking for this issue (no GitHub). */
  clearInMemoryRunState: (issueNumber: number) => void;
  /** Delete the persisted parked/partial run state so detection starts fresh. */
  deleteRunState: (issueNumber: number) => Promise<void>;
  /** Live parked runs (to detect an active l2-gate/integrate decision park). */
  findParkedRuns: () => Promise<ParkedRunInfo[]>;
  /** Last run's work type (run-history fallback for tier inference). */
  lastWorkType?: string;
  /** Structured logger (defaults to console.log). */
  log?: (message: string) => void;
}

type RetryBody = { retrying: number } | ErrorBody;

/** The label that marks an issue as awaiting a cockpit decision answer. */
const DECISION_REQUEST_LABEL = 'decision-request';

function extractLabelNames(
  labels: Array<string | { name?: string | null }> | undefined,
): string[] {
  if (labels === undefined) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : (label.name ?? '');
    if (name.length > 0) names.push(name);
  }
  return names;
}

/** Octokit (and its fakes) surface a `.status` on HTTP errors; 404 ⇒ absent. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 404
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export type StripDecisionBlockResult =
  | { kind: 'absent' }
  | { kind: 'stripped'; body: string }
  | { kind: 'ambiguous'; reason: string };

/**
 * Remove the single cockpit decision-request block from an issue body, mirroring
 * the FAIL-CLOSED rules of `embedDecisionBlock`'s inverse: zero markers → absent
 * (no-op); exactly one balanced pair → stripped; anything else (>1 of either, an
 * unbalanced pair, or end-before-start) → ambiguous (caller must NOT truncate).
 * Surrounding blank lines are collapsed so human content is left clean.
 */
export function stripDecisionBlock(body: string): StripDecisionBlockResult {
  const starts = countOccurrences(body, BLOCK_START);
  const ends = countOccurrences(body, BLOCK_END);

  if (starts === 0 && ends === 0) return { kind: 'absent' };
  if (starts !== 1 || ends !== 1) {
    return {
      kind: 'ambiguous',
      reason: `ambiguous decision block (${starts} start marker(s), ${ends} end marker(s))`,
    };
  }

  const startIdx = body.indexOf(BLOCK_START);
  const endIdx = body.indexOf(BLOCK_END);
  if (endIdx < startIdx) {
    return { kind: 'ambiguous', reason: 'decision block end marker precedes start marker' };
  }

  const before = body.slice(0, startIdx);
  const after = body.slice(endIdx + BLOCK_END.length);
  // Collapse the blank-line separator the block was embedded with, then trim a
  // trailing newline run so the stripped body matches a never-blocked body.
  const stripped = `${before.replace(/\s*$/, '')}\n\n${after.replace(/^\s*/, '')}`
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  return { kind: 'stripped', body: stripped };
}

function err(status: number, message: string): HandlerResult<RetryBody> {
  return { status, body: { error: message } };
}

/**
 * Operator-triggered from-scratch retry of a `stuck` work request. See the file
 * header for the admission rule + reset ordering. Returns a `HandlerResult` the
 * route pipes through `json(res, status, body)`.
 */
export async function retryStuckIssue(
  deps: OperatorRetryDeps,
  issueNumber: number,
): Promise<HandlerResult<RetryBody>> {
  const { octokit, owner, repo } = deps;
  const log = deps.log ?? ((message: string): void => console.log(message));

  // 0. Read current labels + body (one round-trip). A read failure is transient.
  let labels: string[];
  let body: string;
  try {
    const issue = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    labels = extractLabelNames(issue.data.labels);
    body = issue.data.body ?? '';
  } catch (error) {
    log(
      `[operator-retry] failed to read issue #${issueNumber} (${errorMessage(error)}) — nothing touched`,
    );
    return err(503, `could not read issue ${issueNumber}; retry again later`);
  }

  // 1. Admission — ORDER MATTERS (auto-cap adds `blocked` WITHOUT `stuck`).
  if (labels.includes('blocked')) {
    return err(
      409,
      `issue ${issueNumber} is blocked; un-blocking / budget-reset is not supported in v1. Resolve manually or wait for the budget-reset feature.`,
    );
  }

  let parkedRuns: ParkedRunInfo[];
  try {
    parkedRuns = await deps.findParkedRuns();
  } catch (error) {
    // A parked-run read failure must fail CLOSED (we cannot rule out an active
    // decision park) — never silently re-admit a decision-owned issue.
    log(
      `[operator-retry] failed to read parked runs for #${issueNumber} (${errorMessage(error)}) — failing closed`,
    );
    return err(503, `could not verify decision state for issue ${issueNumber}; retry again later`);
  }
  const isDecisionParked =
    labels.includes(DECISION_REQUEST_LABEL) ||
    parkedRuns.some(
      (run) =>
        run.issueNumber === issueNumber &&
        (run.pausedAtPhase === 'l2-gate' || run.pausedAtPhase === 'integrate'),
    );
  if (isDecisionParked) {
    return err(
      409,
      `issue ${issueNumber} is awaiting an Operator decision, not stuck — answer the decision (POST /decisions/<id>/answer) instead of retrying.`,
    );
  }

  if (!labels.includes('stuck')) {
    return err(404, `issue ${issueNumber} is not stuck; nothing to retry.`);
  }

  // 2. Determine the restoration plan up front — an indeterminate work type
  //    must touch NOTHING (no in-memory cleanup, no labels).
  const inference = inferRetryRestoration(labels, deps.lastWorkType);
  if (!inference.ok) {
    return err(
      409,
      `issue ${issueNumber} cannot be retried: ${inference.reason}. Restore the correct entry label manually.`,
    );
  }
  const plan: RetryRestorationPlan = inference.plan;

  // 3. In-memory cleanup FIRST (no GitHub). Any failure → 503, GitHub untouched.
  try {
    deps.clearBackoff(issueNumber);
    deps.clearInMemoryRunState(issueNumber);
    await deps.deleteRunState(issueNumber);
  } catch (error) {
    log(
      `[operator-retry] in-memory reset failed for #${issueNumber} (${errorMessage(error)}) — GitHub untouched, item still stuck`,
    );
    return err(503, `internal reset failed for issue ${issueNumber}; retry again later`);
  }

  // 4. GitHub mutations — strand-safe order. Any failure before `stuck` removal
  //    leaves `stuck`+entry (still excluded → safe, retryable again).
  // (a) ADD the entry label FIRST (idempotent on GitHub).
  try {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [plan.entryLabel],
    });
  } catch (error) {
    log(
      `[operator-retry] failed to restore entry label '${plan.entryLabel}' for #${issueNumber} (${errorMessage(error)}) — item still stuck`,
    );
    return err(503, `failed to restore entry label for issue ${issueNumber}; retry again later`);
  }

  // (b) Strip the leftover decision body-block (fail-closed on ambiguity).
  const strip = stripDecisionBlock(body);
  if (strip.kind === 'ambiguous') {
    log(
      `[operator-retry] refusing to strip ambiguous decision block from #${issueNumber} body (${strip.reason}) — item left stuck`,
    );
    return err(
      409,
      `issue ${issueNumber} has an ambiguous decision block in its body (${strip.reason}); resolve it manually.`,
    );
  }
  if (strip.kind === 'stripped') {
    try {
      await octokit.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        body: strip.body,
      });
    } catch (error) {
      log(
        `[operator-retry] failed to strip decision block from #${issueNumber} body (${errorMessage(error)}) — item still stuck`,
      );
      return err(503, `failed to clean decision block for issue ${issueNumber}; retry again later`);
    }
  }

  // (c) Remove the stale active/claim labels (404 tolerated; real errors abort).
  for (const label of plan.removeActiveLabels) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
    } catch (error) {
      if (isNotFoundError(error)) continue; // label already absent — goal met
      log(
        `[operator-retry] failed to remove active label '${label}' from #${issueNumber} (${errorMessage(error)}) — item still stuck`,
      );
      return err(503, `failed to clear active label for issue ${issueNumber}; retry again later`);
    }
  }

  // (d) Remove `stuck` LAST — only now is the item re-admitted.
  try {
    await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'stuck' });
  } catch (error) {
    if (!isNotFoundError(error)) {
      log(
        `[operator-retry] failed to remove 'stuck' from #${issueNumber} (${errorMessage(error)}) — item still stuck+entry (safe)`,
      );
      return err(503, `failed to re-admit issue ${issueNumber}; retry again later`);
    }
  }

  // 5. Best-effort audit comment — must NOT fail the already-completed retry.
  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `Operator-triggered retry: reset and re-queued from scratch as \`${plan.workType}\` (restored entry label \`${plan.entryLabel}\`).`,
    });
  } catch (error) {
    log(
      `[operator-retry] audit comment failed for #${issueNumber} (best-effort, retry already succeeded): ${errorMessage(error)}`,
    );
  }

  log(
    `[operator-retry] re-queued #${issueNumber} from scratch as ${plan.workType} (entry label ${plan.entryLabel})`,
  );
  return { status: 200, body: { retrying: issueNumber } };
}
