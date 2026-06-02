/**
 * resume-consumer — the daemon-side recognition of the pm-cockpit ANSWER→RESUME
 * write-back (Slice 2: closes the decision loop opened by Slice 1's emit).
 *
 * Slice 1 embeds a `pm-cockpit:decision-request:v1` block into the gate issue
 * BODY and applies the `decision-request` label. When the operator answers in the
 * cockpit inbox, the pm-cockpit watcher writes BACK to the SAME gate issue
 * (mirrored byte-for-byte from pm-cockpit's adapters — DO NOT edit pm-cockpit):
 *
 *   - github-source-sink.writeResponse: posts ONE `**DecisionResponse**` comment
 *     carrying an idempotent effect marker `<!-- pm-cockpit:effect:<id>:etag=<etag> -->`
 *     and (for a non-protected answer) a fenced ```json payload
 *     `{decision_id, chosen_option, answerer, answered_at, idempotency_key}`, then
 *     flips the issue label `decision-request` → `answered`.
 *   - github-requeue-dispatcher.resume: posts `<!-- pm-cockpit:requeue:<effectId> -->`,
 *     reopens the issue if closed, and adds the `ready` label (the registry's
 *     `requeue_label`). (mid_run → "unreachable" ⇒ v1 is REQUEUE only.)
 *
 * AUTHORITATIVE SIGNAL (the keying that prevents double-resume): the parseable
 * `**DecisionResponse**` comment whose JSON `decision_id` === the run's
 * DETERMINISTIC `issue-<n>:l2-gate:<epoch>`. The `answered`/`ready` labels and the
 * `pm-cockpit:requeue:` marker are DISCOVERY/CLEANUP HINTS ONLY — never the
 * approve/reject decision, and never required. Reasoning (from the codex spar):
 *   - the cockpit's label flip and label add are SEPARATE GitHub writes that can be
 *     observed half-applied; acting on a label without the matching response comment
 *     would resume on a half-written answer.
 *   - an old-epoch response (a prior rework cycle's decision) must NOT resume the
 *     current epoch — matching strictly on the current decision_id rules it out.
 *   - if several DecisionResponse comments match, the OLDEST wins (deterministic);
 *     the ledger's answered-once then rejects any conflicting later answer.
 */

import { DecisionResponseSchema } from '@auto-claude/decision-protocol';

/** Live cockpit registry vocab (must match the cockpit's RegistryEntry). */
export const REQUEUE_LABEL = 'ready';
export const ANSWERED_LABEL = 'answered';

/** The decision-request block start marker the cockpit's poller reads from the body. */
const DECISION_REQUEST_BLOCK_MARKER = '<!-- pm-cockpit:decision-request:v1 -->';

/** A subset of a GitHub issue comment — only the body is needed here. */
export interface CommentLike {
  body?: string | null;
}

/** The recognized cockpit answer for a parked decision. */
export interface CockpitAnswer {
  /** approve → continue past the gate; reject → loop back to l2-design. */
  choice: 'approve' | 'reject';
  /**
   * The raw DecisionResponse comment body, surfaced so the daemon can capture
   * rejection feedback (it sanitizes + caps downstream, identically to the
   * l2-gate handler). Always the body of the OLDEST matching comment.
   */
  feedbackBody: string;
}

/**
 * Parse the AUTHORITATIVE cockpit answer for `decisionId` from the issue's
 * comments. Returns the OLDEST `**DecisionResponse**` comment whose embedded JSON
 * `decision_id` matches and whose `chosen_option` is a known option; otherwise
 * `null` (stay parked). Labels are NOT consulted here — the comment is the source
 * of truth, so a half-written answer (label flipped, comment absent) never
 * resumes.
 */
export function parseCockpitAnswer(
  comments: readonly CommentLike[],
  decisionId: string,
): CockpitAnswer | null {
  for (const comment of comments) {
    const body = comment.body;
    if (body == null || body === '') continue;
    if (!body.includes('**DecisionResponse**')) continue;
    const choice = extractMatchingChoice(body, decisionId);
    if (choice === null) continue;
    return { choice, feedbackBody: body };
  }
  return null;
}

/** Extract the FIRST fenced ```json block payload from a comment body, or null. */
function extractJsonFence(body: string): string | null {
  const m = /```json\s*([\s\S]*?)\s*```/.exec(body);
  return m ? m[1]!.trim() : null;
}

/**
 * Extract the chosen option from a DecisionResponse comment body IF its embedded
 * JSON `decision_id` matches `decisionId` AND its `chosen_option` is approve|reject.
 * The payload is validated through the protocol's own `DecisionResponseSchema` (the
 * same typed gate the cockpit serializes against) so the daemon and cockpit agree
 * on the shape. Returns null on any mismatch / unparseable payload (a
 * protected-answer ack carries no JSON payload, so it is correctly ignored here).
 */
function extractMatchingChoice(
  body: string,
  decisionId: string,
): 'approve' | 'reject' | null {
  const rawJson = extractJsonFence(body);
  if (rawJson === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const parsed = DecisionResponseSchema.safeParse(obj);
  if (!parsed.success) return null;
  if (parsed.data.decision_id !== decisionId) return null;
  const chosen = parsed.data.chosen_option;
  if (chosen === 'approve' || chosen === 'reject') return chosen;
  return null;
}

/**
 * isDecisionOwnedIssue — the HARD fresh-work skip guard (codex spar §1/§2). An
 * issue is decision-owned (and therefore NEVER fresh work, despite carrying the
 * cockpit's `ready`/`answered` label) when EITHER:
 *   - its body still carries the decision-request block marker, OR
 *   - its number is in the live set of parked l2-gate decision runs.
 *
 * BOTH conditions are required as a union (neither alone is sufficient):
 *   - the body marker catches the post-unpark window where `findParkedRuns()` no
 *     longer returns the run but a stale `ready` label still sits on the issue, and
 *     covers a TOCTOU where the cockpit added `ready` to an issue the daemon has
 *     not yet re-scanned as parked.
 *   - the parked-number set catches a body whose marker was stripped/edited/super-
 *     seded but whose run is still genuinely parked awaiting the answer.
 *
 * The cockpit's requeue (`ready`) label aliases the daemon's own NEW-work label,
 * so without this guard the new-work poll would spawn a DUPLICATE run for the same
 * issue — the #1 loop-killer this slice closes.
 */
export function isDecisionOwnedIssue(
  body: string | undefined | null,
  issueNumber: number,
  parkedDecisionIssueNumbers: ReadonlySet<number>,
): boolean {
  if (parkedDecisionIssueNumbers.has(issueNumber)) return true;
  if (body != null && body.includes(DECISION_REQUEST_BLOCK_MARKER)) return true;
  return false;
}
