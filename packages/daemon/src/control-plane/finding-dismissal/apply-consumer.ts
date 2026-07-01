/**
 * finding-dismissal/apply-consumer.ts — the answer-apply consumer (PR1), a
 * SIBLING scan loop wired BESIDE `resumeParkedRuns` in `daemon.ts` (never inside
 * it). This is the load-bearing correctness of the flow.
 *
 * WHY a separate consumer (codex CRITICAL-1): the live `/answer` endpoint only
 * POSTs a `**DecisionResponse**` comment — it does NOT call `ledger.answer()`.
 * For runs, `ledger.answer()` is driven later INSIDE `resumeParkedRuns`. A finding
 * has no parked run, so THIS consumer must drive `ledger.answer()` itself.
 * `resumeParkedRuns` iterates parked RunState (l2-gate / integrate only) and will
 * NEVER touch finding rows — and conversely this consumer selects ONLY
 * finding-dismissal rows (by the `:finding-dismissal:` id convention), so the two
 * paths are disjoint.
 *
 * DURABLE-FIRST ORDERING (the load-bearing correctness — closes the reconcile
 * race): `ledger.answer()` advances the row to `answered_pending_source_write`,
 * which queues the generic `write_response`→resume effect. The daemon's per-tick
 * generic reconcile (`daemon.ts`, runs BEFORE this consumer) — or a crash — can
 * drive that queued effect all the way to terminal `resumed` INDEPENDENTLY of this
 * consumer (`outbox.expectedEffect('answered_pending_source_write') ===
 * 'write_response'`). Once terminal, `ledger.pending()` no longer returns the row,
 * so any verdict/observation not yet written would be LOST forever. Within-consumer
 * await-ordering cannot prevent that, because the LEDGER terminalizes out from
 * under us. The fix: write the durable artifacts BEFORE calling `ledger.answer()`,
 * so verdict + observation are a strict PREREQUISITE of the ledger answer. Then
 * terminalization by ANYONE (this consumer's `advanceToResumed` OR the generic
 * reconcile) can never lose them. Order, ALL AWAITED:
 *
 *   verdict labels + audit comment → observeDecisionAnswer(sourceDecisionId)
 *     → ledger.answer() → ledger.advanceToResumed() (terminalize)
 *
 * (The requeue/resume effect a finding row triggers is benign in v1: the wired
 * `AckResumeDispatcher` only records an in-memory ack — no GitHub `ready` label or
 * reopen — so a finding terminalizing has no run-spawning side effect.)
 *
 * Each tick, scan `ledger.pending()` (EVERY non-terminal row — seeing an
 * answered-but-not-terminalized row is exactly what makes crash-recovery work) and,
 * for each finding row whose issue carries an Operator DecisionResponse, drive the
 * verdict durably. A crash/retry at ANY point re-applies idempotently (labels
 * no-op, audit comment deduped by marker, observation deduped by `sourceDecisionId`,
 * `ledger.answer` answered-once).
 */
import { parseCockpitAnswer, type CommentLike } from '../decision-escalation/resume-consumer.js';
import {
  isFindingDismissalDecisionId,
  parseFindingDismissalDecisionId,
} from './build-request.js';
import { findingDismissalClass, verdictLabelFor } from './labels.js';

/** The narrow ledger surface the consumer drives (satisfied by DecisionLedger). */
export interface ConsumerLedger {
  pending(): Promise<Array<{ decision_id: string; status: string; source_url: string }>>;
  statusOf(decisionId: string): Promise<string | undefined>;
  /**
   * The STORED recommended_option that was raised and shown for this decision (the
   * rung-2 pre-fill hint), or null. Read to record an HONEST `matchedRecommendation`
   * from the value the Operator actually saw — never a re-derive.
   */
  recommendedOptionOf(decisionId: string): Promise<string | null>;
  answer(
    decisionId: string,
    chosenOption: string,
    answerer: string,
  ): Promise<{ applied: boolean; status: string }>;
  advanceToResumed(decisionId: string): Promise<void>;
  supersede(decisionId: string, supersededBy?: string): Promise<boolean>;
}

/** The narrow GitHub issue surface the consumer reads + writes. */
export interface ConsumerOctokit {
  issues: {
    get(args: { owner: string; repo: string; issue_number: number }): Promise<{
      data: { state?: string | null };
    }>;
    listComments(args: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: CommentLike[] }>;
    addLabels(args: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<unknown>;
    createComment(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<unknown>;
  };
}

/** The narrow operator-learning surface the consumer observes into. */
export interface ConsumerLearning {
  observeDecisionAnswer(input: {
    decisionClass: string;
    context: string;
    sourceDecisionId: string;
    chosenOption: string;
    /**
     * The recommended_option that was SHOWN on the decision (the rung-2 pre-fill),
     * if any. `observeDecisionAnswer` sets `matchedRecommendation` from it — so the
     * consumer passes the STORED value, keeping the record honest.
     */
    recommendedOption?: string;
  }): Promise<void>;
}

export interface FindingDismissalConsumerDeps {
  ledger: ConsumerLedger;
  octokit: ConsumerOctokit;
  operatorLearning: ConsumerLearning;
  owner: string;
  repo: string;
}

/** GitHub comments page size + a defensive page cap (5000 comments). */
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 50;

/** `https://github.com/<owner>/<repo>/issues/<n>` → the same shape deriveLearningKey parses. */
const ISSUE_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#]|$)/;

function ownerRepoFromSourceUrl(sourceUrl: string): { owner: string; repo: string } | null {
  const m = ISSUE_URL_RE.exec(sourceUrl);
  if (m === null) return null;
  const owner = m[1];
  const repo = m[2];
  if (owner === undefined || owner.length === 0 || repo === undefined || repo.length === 0) {
    return null;
  }
  return { owner, repo };
}

/**
 * fetchAllComments — page through the issue's comments so a DecisionResponse past
 * the first 100 comments is still found (a single-page read could miss it
 * indefinitely). Stops at the first short page or the defensive cap.
 */
async function fetchAllComments(
  octokit: ConsumerOctokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<CommentLike[]> {
  const all: CommentLike[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const res = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: COMMENTS_PER_PAGE,
      page,
    });
    const batch = res.data ?? [];
    all.push(...batch);
    if (batch.length < COMMENTS_PER_PAGE) break;
  }
  return all;
}

/**
 * runFindingDismissalConsumer — one scan tick. Selects finding-dismissal rows
 * from `ledger.pending()` for THIS repo and drives each answered finding to a
 * durable verdict + observation + terminalization. Per-row failures are isolated
 * (one bad row never aborts the scan). Returns the number of rows terminalized
 * this tick (for logging/tests).
 */
export async function runFindingDismissalConsumer(
  deps: FindingDismissalConsumerDeps,
): Promise<number> {
  const { ledger, owner, repo } = deps;
  let applied = 0;
  let rows: Array<{ decision_id: string; status: string; source_url: string }>;
  try {
    rows = await ledger.pending();
  } catch (e) {
    console.warn(
      `[finding-dismissal] consumer: pending() read failed (skipping tick): ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }

  for (const row of rows) {
    // Select ONLY finding-dismissal rows (resumeParkedRuns never sees these; this
    // is the only processor). An l2-gate / integrate row is skipped here.
    if (!isFindingDismissalDecisionId(row.decision_id)) continue;
    const parsed = parseFindingDismissalDecisionId(row.decision_id);
    if (parsed === null) continue; // malformed id → neutral, never crash/mis-key.

    // Only act on THIS repo's findings (the injected octokit is this repo's).
    const ctx = ownerRepoFromSourceUrl(row.source_url);
    if (ctx === null || ctx.owner !== owner || ctx.repo !== repo) continue;

    try {
      const didApply = await processFindingRow(deps, row.decision_id, parsed.issueNumber, parsed.category);
      if (didApply) applied += 1;
    } catch (e) {
      console.warn(
        `[finding-dismissal] consumer: apply failed for ${row.decision_id} (continuing): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return applied;
}

async function processFindingRow(
  deps: FindingDismissalConsumerDeps,
  decisionId: string,
  issueNumber: number,
  category: Parameters<typeof findingDismissalClass>[0],
): Promise<boolean> {
  const { ledger, octokit, operatorLearning, owner, repo } = deps;

  // Idempotent re-entry: a terminal `resumed` row was already fully consumed.
  const status = await ledger.statusOf(decisionId);
  if (status === 'resumed') return false;

  // Closed/moot finding → supersede (terminalize WITHOUT applying), never block.
  let issueState: string;
  try {
    const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    issueState = data.state ?? 'open';
  } catch (e) {
    console.warn(
      `[finding-dismissal] consumer: issue.get failed for #${issueNumber} (staying pending): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
  if (issueState === 'closed') {
    await ledger.supersede(decisionId, `${decisionId}:moot`);
    return false;
  }

  // Read comments (PAGINATED) + parse the AUTHORITATIVE Operator answer
  // (keep=approve / dismiss=reject).
  let comments: CommentLike[];
  try {
    comments = await fetchAllComments(octokit, owner, repo, issueNumber);
  } catch (e) {
    console.warn(
      `[finding-dismissal] consumer: listComments failed for #${issueNumber} (staying pending): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
  const answer = parseCockpitAnswer(comments, decisionId);
  if (answer === null) return false; // no answer yet → stays pending.

  // DURABLE-FIRST ORDERING (closes the reconcile race — see the module header):
  // write the durable artifacts BEFORE ledger.answer() so they are a strict
  // prerequisite of terminalization. Then a generic reconcile / crash that
  // terminalizes the row after answer() can never lose them. ALL AWAITED.
  //
  // 1) verdict labels (`kept`/`dismissed`) + a single (marker-deduped) audit comment.
  await applyVerdict(octokit, owner, repo, issueNumber, decisionId, answer.choice, comments);
  // Read the STORED recommended_option (the rung-2 pre-fill the Operator saw) — a pure
  // read, so it does not disturb the durable-first chain. `matchedRecommendation` is
  // computed from THIS shown value (never a re-derive), and is undefined-safe when
  // the decision had no pre-fill (null → undefined → matched=false).
  //
  // FAIL-OPEN (codex): this advisory read sits AFTER the verdict is already written but
  // BEFORE observe/answer/advance. An unguarded throw here would abort the row via the
  // caller's catch with the verdict applied yet the row never terminalized — stranding
  // the answered finding in `pending` forever. Degrade a read failure to "no recorded
  // recommendation" and press on: the observation + answer + terminalization still run.
  let shownRec: string | null = null;
  try {
    shownRec = await ledger.recommendedOptionOf(decisionId);
  } catch (e) {
    console.warn(
      `[finding-dismissal] consumer: recommendedOptionOf failed for ${decisionId} (observing with no recommendation, continuing): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 2) the learned observation (deduped by sourceDecisionId — a replay never inflates).
  await operatorLearning.observeDecisionAnswer({
    decisionClass: findingDismissalClass(category),
    context: `${owner}/${repo}`,
    sourceDecisionId: decisionId,
    chosenOption: answer.choice,
    recommendedOption: shownRec ?? undefined,
  });
  // 3) NOW record the answer in the ledger (answered-once: a replay is a no-op).
  await ledger.answer(decisionId, answer.rawChosenOption, 'operator');
  // 4) terminalize (idempotent — a no-op if the generic reconcile already did it).
  await ledger.advanceToResumed(decisionId);
  return true;
}

/**
 * applyVerdict — idempotent verdict label (`kept`/`dismissed`) + a single audit
 * comment. `addLabels` is naturally idempotent on GitHub. The audit comment
 * carries a deterministic marker so a crash-replay (which re-fetches comments)
 * sees it and does NOT double-post.
 */
async function applyVerdict(
  octokit: ConsumerOctokit,
  owner: string,
  repo: string,
  issueNumber: number,
  decisionId: string,
  choice: 'approve' | 'reject',
  comments: readonly CommentLike[],
): Promise<void> {
  const verdict = verdictLabelFor(choice);
  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [verdict],
  });

  const marker = `<!-- finding-dismissal:verdict:${decisionId} -->`;
  const alreadyAudited = comments.some((c) => (c.body ?? '').includes(marker));
  if (!alreadyAudited) {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `${marker}\n**Finding ${verdict}:** the Operator ${choice === 'approve' ? 'kept' : 'dismissed'} this review finding.`,
    });
  }
}
