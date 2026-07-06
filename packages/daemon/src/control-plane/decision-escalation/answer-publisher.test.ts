/**
 * RED behavioral gate for answer-publisher (Slice 7c) — the daemon ANSWER→RESUME
 * write-back transport (STACK-AC-OPERATOR-SURFACE-API / ARCH-AC-OPERATOR-SURFACE).
 *
 * THE CRITICAL CONTRACT: what the publisher POSTS, the proven resume loop
 * recognizes. So the builder's output is asserted to round-trip through the REAL
 * `parseCockpitAnswer` (resume-consumer.ts) — the same function `resumeParkedRuns`
 * calls — for BOTH approve and reject. If this passes, an answer posted by the
 * endpoint is provably resumable by the existing loop with ZERO change to
 * `resumeParkedRuns`/`parseCockpitAnswer`.
 *
 * The builder is PURE (no GitHub), so the gate exercises it directly. The I/O post
 * is exercised with an injected fake `createComment`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDecisionResponseComment,
  postDecisionResponse,
  type CreateCommentApi,
} from './answer-publisher.js';
import { parseCockpitAnswer } from './resume-consumer.js';

const DECISION_ID = 'issue-42:l2-gate:1';
const IDEMPOTENCY_KEY = 'op-answer-abc123';

describe('buildDecisionResponseComment', () => {
  it('embeds the effect marker for the decisionId + the DecisionResponse literal + a fenced json with chosen_option (approve)', () => {
    const body = buildDecisionResponseComment(DECISION_ID, 'approve', IDEMPOTENCY_KEY);
    // the effect marker binding this decisionId as the write_response target.
    expect(body).toContain(`pm-cockpit:effect:${DECISION_ID}:write_response`);
    // the authoritative literal parseCockpitAnswer screens on.
    expect(body).toContain('**DecisionResponse**');
    // a fenced json block carrying the chosen_option.
    expect(body).toMatch(/```json[\s\S]*"chosen_option"[\s\S]*"approve"[\s\S]*```/);
  });

  it('carries the chosen_option in the JSON, NOT the decision_id (the decision_id lives in the marker)', () => {
    const body = buildDecisionResponseComment(DECISION_ID, 'reject', IDEMPOTENCY_KEY);
    const fence = /```json\s*([\s\S]*?)\s*```/.exec(body);
    expect(fence).not.toBeNull();
    const payload = JSON.parse(fence![1]!.trim()) as Record<string, unknown>;
    expect(payload.chosen_option).toBe('reject');
    // the JSON is minimal — the decision_id is NOT in the payload (it is in the marker).
    expect(payload.decision_id).toBeUndefined();
  });

  it('CONTRACT: an approve body round-trips through the REAL parseCockpitAnswer to choice=approve', () => {
    const body = buildDecisionResponseComment(DECISION_ID, 'approve', IDEMPOTENCY_KEY);
    const answer = parseCockpitAnswer([{ body }], DECISION_ID);
    expect(answer).not.toBeNull();
    expect(answer!.choice).toBe('approve');
    expect(answer!.rawChosenOption).toBe('approve');
  });

  it('CONTRACT: a reject body round-trips through the REAL parseCockpitAnswer to choice=reject', () => {
    const body = buildDecisionResponseComment(DECISION_ID, 'reject', IDEMPOTENCY_KEY);
    const answer = parseCockpitAnswer([{ body }], DECISION_ID);
    expect(answer).not.toBeNull();
    expect(answer!.choice).toBe('reject');
    expect(answer!.rawChosenOption).toBe('reject');
  });

  it('CONTRACT: an approve-with-debut body round-trips to choice=approve with the raw debut option preserved (codex P4.2)', () => {
    // The daemon answer path posts `approve-with-debut` for a release-phase debut
    // answer; parseCockpitAnswer must recognize it (semantic approve) while keeping
    // the raw option so release/read-answer.ts reads back the debut authorization.
    const releaseId = 'release:acme/widgets:abc12345';
    const body = buildDecisionResponseComment(releaseId, 'approve-with-debut', IDEMPOTENCY_KEY);
    const answer = parseCockpitAnswer([{ body }], releaseId);
    expect(answer).not.toBeNull();
    expect(answer!.choice).toBe('approve');
    expect(answer!.rawChosenOption).toBe('approve-with-debut');
  });

  it('is bound to its decisionId — parseCockpitAnswer for a DIFFERENT decision_id does NOT match (no cross-epoch resume)', () => {
    const body = buildDecisionResponseComment(DECISION_ID, 'approve', IDEMPOTENCY_KEY);
    // a different epoch (different decision_id) must never resume on this comment.
    const answer = parseCockpitAnswer([{ body }], 'issue-42:l2-gate:2');
    expect(answer).toBeNull();
  });
});

describe('postDecisionResponse', () => {
  it('builds the recognized body and posts it via the injected createComment to the gate issue', async () => {
    const calls: Array<{ owner: string; repo: string; issue_number: number; body: string }> = [];
    const createComment: CreateCommentApi = async (args) => {
      calls.push(args);
      return {};
    };
    await postDecisionResponse({
      decisionId: DECISION_ID,
      chosenOption: 'approve',
      idempotencyKey: IDEMPOTENCY_KEY,
      createComment,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.owner).toBe('acme');
    expect(calls[0]!.repo).toBe('widgets');
    expect(calls[0]!.issue_number).toBe(42);
    // the posted body is the recognized artifact (round-trips through the real parser).
    const answer = parseCockpitAnswer([{ body: calls[0]!.body }], DECISION_ID);
    expect(answer?.choice).toBe('approve');
  });
});
