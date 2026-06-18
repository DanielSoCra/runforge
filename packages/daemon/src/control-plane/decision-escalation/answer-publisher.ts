/**
 * answer-publisher — the daemon ANSWER→RESUME write-back transport (Slice 7c).
 *
 * DESIGN (Option A — post a DecisionResponse, reuse the proven resume engine):
 * an operator answer must RESUME the parked run. The proven engine
 * `resumeParkedRuns` (daemon.ts) recognizes a `**DecisionResponse**` comment on
 * the gate issue via `parseCockpitAnswer` (resume-consumer.ts) and drives
 * `ledger.answer` + `advanceToResumed`. So the daemon answer endpoint POSTS that
 * exact comment artifact — it does NOT call `ledger.answer()` directly (a direct
 * ledger write would record an answer the resume loop never observes and STRAND
 * the run). The existing loop then resumes the run on its next tick. ZERO change
 * to `resumeParkedRuns` / `parseCockpitAnswer`.
 *
 * THE EXACT ARTIFACT (must match `extractMatchingChoice` in resume-consumer.ts):
 * a comment whose body contains
 *   - the effect marker `pm-cockpit:effect:<decisionId>:write_response:<key>`
 *     (resume-consumer matches `pm-cockpit:effect:<decisionId>:write_response\b`,
 *     and the `:` after `write_response` is a non-word boundary, so a trailing
 *     `:<idempotencyKey>` is recognized — this mirrors the cockpit's own
 *     deterministic effectId `<decision_id>:write_response:<idempotency_key>`);
 *   - the literal `**DecisionResponse**`;
 *   - a fenced ```json block whose `chosen_option` ∈ {approve, reject} (the
 *     resume-consumer also accepts the legacy `approve-merge` alias, but the
 *     operator surface only ever emits `approve` / `reject`).
 * The decision_id is carried in the MARKER, NOT in the JSON — the JSON is the
 * minimal `{ "chosen_option": "<choice>" }` the cockpit writes (mirrored
 * byte-for-byte so the SAME `parseCockpitAnswer` recognizes both transports).
 *
 * SPLIT (testability): the PURE body-builder
 * (`buildDecisionResponseComment`) is unit-tested WITHOUT GitHub — the gate
 * asserts its output round-trips through the REAL `parseCockpitAnswer`. The I/O
 * post (`postDecisionResponse`) takes an injected octokit-like `createComment`,
 * so the publisher is fakeable in tests.
 */

/** The choices the operator surface emits (resume-consumer maps each to a `choice`). */
export type AnswerChoice = 'approve' | 'reject';

/**
 * Build the DecisionResponse comment body for `(decisionId, chosenOption)`. Pure
 * string construction — no I/O — so it is unit-testable and its output is
 * provably recognized by `parseCockpitAnswer`.
 *
 * The body MUST contain, in order:
 *   1. the effect marker `<!-- pm-cockpit:effect:<decisionId>:write_response:<idempotencyKey> -->`
 *   2. the literal `**DecisionResponse**`
 *   3. a fenced ```json block: `{ "chosen_option": "<chosenOption>" }`
 *
 * @param decisionId      the parked decision id (e.g. `issue-42:l2-gate:1`); bound
 *                        into the effect marker so the resume loop matches strictly
 *                        on the current epoch (cross-epoch answers never resume).
 * @param chosenOption    `approve` | `reject` — written verbatim into the JSON.
 * @param idempotencyKey  the cockpit-style idempotency suffix on the effect marker;
 *                        any value is fine (the resume matcher anchors on
 *                        `write_response\b`, so the trailing `:<key>` is recognized).
 */
export function buildDecisionResponseComment(
  decisionId: string,
  chosenOption: AnswerChoice,
  idempotencyKey: string,
): string {
  return [
    `<!-- pm-cockpit:effect:${decisionId}:write_response:${idempotencyKey} -->`,
    '**DecisionResponse**',
    '```json',
    `{"chosen_option":"${chosenOption}"}`,
    '```',
  ].join('\n');
}

/** Minimal Octokit comment surface this publisher needs (keeps the dep narrow + testable). */
export interface CreateCommentApi {
  (args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<unknown>;
}

/** Args for posting a DecisionResponse to the gate issue. */
export interface PostDecisionResponseArgs {
  decisionId: string;
  chosenOption: AnswerChoice;
  idempotencyKey: string;
  createComment: CreateCommentApi;
  owner: string;
  repo: string;
  issueNumber: number;
}

/**
 * Post the DecisionResponse comment to the gate issue via the injected
 * `createComment`. Builds the body with `buildDecisionResponseComment`, then posts
 * it — the resume loop recognizes it on its next tick (NEVER a direct
 * `ledger.answer()`).
 */
export async function postDecisionResponse(
  args: PostDecisionResponseArgs,
): Promise<void> {
  const {
    decisionId,
    chosenOption,
    idempotencyKey,
    createComment,
    owner,
    repo,
    issueNumber,
  } = args;
  const body = buildDecisionResponseComment(
    decisionId,
    chosenOption,
    idempotencyKey,
  );
  await createComment({ owner, repo, issue_number: issueNumber, body });
}
