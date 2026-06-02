/**
 * github-block-notifier — the REAL publisher that delivers a daemon-raised
 * `DecisionRequest` to the pm-cockpit inbox. This is Slice 1 of wiring the
 * decision loop: the single physical wire daemon -> cockpit that the v1
 * `LogNotifier` (adapters.ts) deferred ("v1: log only. A real adapter would
 * deliver here.").
 *
 * THE TRANSPORT IS THE GATE ISSUE BODY. pm-cockpit's issue-poller ingests by
 * reading `issue.body` (extractDecisionBlock(issue.body) / parseDecisionBlock),
 * NOT comments, so the block MUST live in the issue BODY. The block format is
 * pm-cockpit's `pm-cockpit:decision-request:v1`: a marker pair wrapping a fenced
 * ```json payload of the serialized DecisionRequest. A label
 * (default `decision-request`) marks the issue so the cockpit's label-filtered
 * poll picks it up.
 *
 * WHY publish here and not inside the index `Notifier`: the decision-index
 * `Notifier.notify(args)` only receives `{decision_id, channel, effectId}` — NOT
 * the full request — so it cannot render the canonical block without lossily
 * reconstructing it from the read model. The daemon already holds the full
 * canonical `DecisionRequest` at the l2-gate park call site; that is the correct
 * seam. The index `Notifier` stays the local-lifecycle ping; this publisher is
 * the cross-system delivery.
 *
 * FAIL-CLOSED: the rendered block is validated (committed-protocol JSON shape via
 * the package's own `DecisionRequestSchema` round-trip + `assertFullyClassified`
 * sensitivity-completeness gate) BEFORE any GitHub write. A block that would not
 * validate is NEVER written — the run stays parked. AJV/Zod-shape validation
 * alone does not prove the sensitivity map is complete, so we run both gates on
 * the bytes we are about to write.
 *
 * IDEMPOTENT: the body embed is insert-if-absent / replace-the-single-marked-
 * region-in-place / preserve all human content. A re-park (same deterministic
 * decision_id) re-renders an identical block, the body is already identical, and
 * no redundant write is issued. A new epoch (new decision_id, same issue) renders
 * a fresh block that REPLACES the prior one in place (the latest epoch wins). The
 * label add is naturally idempotent on GitHub.
 */
import {
  DecisionRequestSchema,
  assertFullyClassified,
  type DecisionRequest,
} from '@auto-claude/decision-protocol';

/** Cockpit v1 block markers (must byte-match pm-cockpit's decision-block.ts). */
export const BLOCK_START = '<!-- pm-cockpit:decision-request:v1 -->';
export const BLOCK_END = '<!-- /pm-cockpit:decision-request -->';

/** Default label that marks a decision-request issue (cockpit registry default). */
export const DEFAULT_DECISION_LABEL = 'decision-request';

/**
 * Render the canonical decision-request block: the cockpit markers wrapping a
 * fenced ```json payload of the serialized request. The JSON is pretty-printed
 * for human-readability in the issue body (the cockpit canonicalizes before
 * hashing, so whitespace is irrelevant to its etag).
 */
export function renderDecisionBlock(request: DecisionRequest): string {
  const json = JSON.stringify(request, null, 2);
  return `${BLOCK_START}\n\`\`\`json\n${json}\n\`\`\`\n${BLOCK_END}`;
}

/** Result of validating a rendered block before any write (fail-closed gate). */
export interface BlockValidation {
  valid: boolean;
  /** machine reason when invalid (never written): malformed_json | schema_invalid | sensitivity_incomplete. */
  reason?: string;
}

/**
 * Validate the BYTES we are about to write. Extracts the JSON payload from the
 * rendered block, parses it, runs the package's `DecisionRequestSchema` (the same
 * typed gate the cockpit applies), and then `assertFullyClassified` (the
 * fail-closed §5.1 sensitivity-completeness gate that schema validation alone
 * does not cover). Any failure -> `{valid:false, reason}` and the caller MUST NOT
 * write.
 */
export function validateRenderedBlock(blockText: string): BlockValidation {
  const rawJson = extractBlockJson(blockText);
  if (rawJson === null) return { valid: false, reason: 'malformed_json' };
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return { valid: false, reason: 'malformed_json' };
  }
  const parsed = DecisionRequestSchema.safeParse(obj);
  if (!parsed.success) return { valid: false, reason: 'schema_invalid' };
  try {
    assertFullyClassified(parsed.data);
  } catch {
    return { valid: false, reason: 'sensitivity_incomplete' };
  }
  return { valid: true };
}

/**
 * Extract the raw JSON payload between the cockpit markers (mirrors pm-cockpit's
 * extractDecisionBlock). Returns null when no well-formed block is present.
 */
function extractBlockJson(body: string): string | null {
  const m = blockRe().exec(body);
  return m ? m[1]!.trim() : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The cockpit's block-extraction regex (single block; non-greedy json fence). */
function blockRe(): RegExp {
  return new RegExp(
    `${escapeRe(BLOCK_START)}\\s*\\u0060\\u0060\\u0060json\\s*([\\s\\S]*?)\\s*\\u0060\\u0060\\u0060\\s*${escapeRe(
      BLOCK_END,
    )}`,
  );
}

/**
 * Idempotently embed `blockText` into an issue `body`, preserving ALL human
 * content:
 *   - zero markers      -> APPEND the block (separated by a blank line).
 *   - exactly one block  -> REPLACE the marked region in place (latest wins).
 *   - >1 start/end, or an unbalanced pair (start without a matching end)
 *                        -> FAIL CLOSED (throw): the body is in an ambiguous
 *                           state we refuse to guess at.
 */
export function embedDecisionBlock(body: string, blockText: string): string {
  const starts = countOccurrences(body, BLOCK_START);
  const ends = countOccurrences(body, BLOCK_END);

  if (starts === 0 && ends === 0) {
    // append, preserving the human body with a blank-line separator.
    const trimmed = body.replace(/\s*$/, '');
    return trimmed.length > 0 ? `${trimmed}\n\n${blockText}` : blockText;
  }

  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `decision block embed refused: ambiguous body (${starts} start marker(s), ${ends} end marker(s))`,
    );
  }

  const startIdx = body.indexOf(BLOCK_START);
  const endIdx = body.indexOf(BLOCK_END);
  if (endIdx < startIdx) {
    throw new Error(
      'decision block embed refused: end marker precedes start marker',
    );
  }
  const before = body.slice(0, startIdx);
  const after = body.slice(endIdx + BLOCK_END.length);
  return `${before}${blockText}${after}`;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Minimal Octokit surface this publisher needs (keeps the dep narrow + testable). */
export interface IssuesApi {
  get(args: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<{ data: { body?: string | null } }>;
  update(args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<unknown>;
  addLabels(args: {
    owner: string;
    repo: string;
    issue_number: number;
    labels: string[];
  }): Promise<unknown>;
}
export interface OctokitLike {
  issues: IssuesApi;
}

export interface EnsureArgs {
  request: DecisionRequest;
  octokit: OctokitLike;
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Outcome of an ensure() attempt. `posted:false` always means nothing harmful was left half-written for the WRITE phase, and the run should stay parked / retry. */
export interface PublishResult {
  posted: boolean;
  /** reason when not posted: schema_invalid | sensitivity_incomplete | malformed_json | write_failed. */
  reason?: string;
}

export interface GitHubBlockPublisherOptions {
  /** Label that marks a decision-request issue (cockpit-configurable). */
  decisionLabel?: string;
}

/**
 * GitHubBlockPublisher — embeds a decision-request block in the gate issue BODY
 * (fail-closed, idempotent) and applies the decision label. The single physical
 * wire daemon -> cockpit inbox.
 */
export class GitHubBlockPublisher {
  private readonly decisionLabel: string;

  constructor(opts: GitHubBlockPublisherOptions = {}) {
    this.decisionLabel = opts.decisionLabel ?? DEFAULT_DECISION_LABEL;
  }

  /**
   * Ensure the gate issue body carries the canonical decision block and the
   * decision label. Safe to call repeatedly (idempotent). FAIL-CLOSED: validates
   * the rendered bytes BEFORE any write; a body-write failure surfaces as
   * `posted:false` and the label is NOT applied (a labeled issue must always have
   * a block, so we never label without a confirmed body write).
   */
  async ensure(args: EnsureArgs): Promise<PublishResult> {
    const { request, octokit, owner, repo, issueNumber } = args;
    const block = renderDecisionBlock(request);

    // 1) FAIL-CLOSED validation of the exact bytes — before ANY GitHub call.
    const validation = validateRenderedBlock(block);
    if (!validation.valid) {
      console.error(
        `[decision-escalation] refusing to publish malformed decision block for #${issueNumber} (${validation.reason}) — staying parked`,
      );
      return { posted: false, reason: validation.reason };
    }

    // 2) read the current body and idempotently embed the block.
    let currentBody: string;
    try {
      const issue = await octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      currentBody = issue.data.body ?? '';
    } catch (e) {
      console.error(
        `[decision-escalation] failed to read issue #${issueNumber} body (staying parked): ${msg(e)}`,
      );
      return { posted: false, reason: 'write_failed' };
    }

    let nextBody: string;
    try {
      nextBody = embedDecisionBlock(currentBody, block);
    } catch (e) {
      // ambiguous body (multiple/unbalanced markers) -> fail closed, do not write.
      console.error(
        `[decision-escalation] refusing to embed decision block into ambiguous body for #${issueNumber}: ${msg(e)}`,
      );
      return { posted: false, reason: 'malformed_json' };
    }

    // 3) write the body FIRST (skip when already identical — idempotent no-op).
    if (nextBody !== currentBody) {
      try {
        await octokit.issues.update({
          owner,
          repo,
          issue_number: issueNumber,
          body: nextBody,
        });
      } catch (e) {
        console.error(
          `[decision-escalation] failed to write decision block to #${issueNumber} (staying parked, label NOT applied): ${msg(e)}`,
        );
        return { posted: false, reason: 'write_failed' };
      }
    }

    // 4) apply the decision label SECOND (naturally idempotent on GitHub) so a
    //    labeled issue always carries a block.
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [this.decisionLabel],
      });
    } catch (e) {
      // body is durably embedded; a label failure is recoverable on the next tick.
      console.warn(
        `[decision-escalation] decision block written to #${issueNumber} but label add failed (will retry): ${msg(e)}`,
      );
      return { posted: false, reason: 'write_failed' };
    }

    return { posted: true };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Re-export the protocol schema so callers can build/validate without a second import. */
export { DecisionRequestSchema };
