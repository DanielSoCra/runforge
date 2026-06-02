import { describe, it, expect } from 'vitest';
import {
  parseCockpitAnswer,
  isDecisionOwnedIssue,
  REQUEUE_LABEL,
  ANSWERED_LABEL,
} from './resume-consumer.js';

/**
 * resume-consumer — the daemon-side recognition of the pm-cockpit answer write-back.
 * These tests pin the PARSING contract against the cockpit's actual byte format
 * (mirrored from pm-cockpit github-source-sink.ts / github-requeue-dispatcher.ts):
 *   - `**DecisionResponse**` comment with a ```json {decision_id, chosen_option,...}
 *     payload + an effect marker `<!-- pm-cockpit:effect:<id>:etag=<etag> -->`.
 *   - the decision-request body block marker `<!-- pm-cockpit:decision-request:v1 -->`.
 *   - the requeue comment marker `<!-- pm-cockpit:requeue:<effectId> -->`.
 *
 * The AUTHORITATIVE resume signal is the DecisionResponse comment whose JSON
 * decision_id matches the run's deterministic id — NOT the `answered`/`ready`
 * labels (those are discovery/cleanup hints only). A half-written answer (label
 * flipped, comment not yet posted, or vice-versa) must NOT resume.
 */

const DECISION_ID = 'issue-100:l2-gate:1';

/** Build the cockpit's DecisionResponse comment body for a chosen option. */
function decisionResponseComment(
  decisionId: string,
  chosenOption: string,
  etag = 'etag-abc',
): string {
  const effectId = `${decisionId}:write_response:${decisionId}:answer`;
  const marker = `<!-- pm-cockpit:effect:${effectId}:etag=${etag} -->`;
  const payload = JSON.stringify({
    decision_id: decisionId,
    chosen_option: chosenOption,
    answerer: 'operator',
    answered_at: '2026-06-02T00:00:00.000Z',
    idempotency_key: `${decisionId}:answer`,
  });
  return [marker, '**DecisionResponse**', '```json', payload, '```'].join('\n');
}

describe('parseCockpitAnswer', () => {
  it('recognizes an approve DecisionResponse comment matching the decision_id', () => {
    const comments = [
      { body: 'human chatter' },
      { body: decisionResponseComment(DECISION_ID, 'approve') },
    ];
    const result = parseCockpitAnswer(comments, DECISION_ID);
    expect(result).not.toBeNull();
    expect(result?.choice).toBe('approve');
  });

  it('recognizes a reject DecisionResponse and exposes the raw comment body as feedback', () => {
    const comments = [
      { body: decisionResponseComment(DECISION_ID, 'reject') },
    ];
    const result = parseCockpitAnswer(comments, DECISION_ID);
    expect(result?.choice).toBe('reject');
    // feedback is the comment body verbatim (the daemon sanitizes/caps downstream).
    expect(result?.feedbackBody).toContain('DecisionResponse');
    expect(result?.feedbackBody).toContain('reject');
  });

  it('returns null when no DecisionResponse comment matches the decision_id (different epoch)', () => {
    const comments = [
      { body: decisionResponseComment('issue-100:l2-gate:2', 'approve') },
    ];
    expect(parseCockpitAnswer(comments, DECISION_ID)).toBeNull();
  });

  it('returns null when there is no DecisionResponse comment at all (labels alone never resume)', () => {
    const comments = [
      { body: 'just a normal comment' },
      { body: '<!-- pm-cockpit:requeue:some-effect -->\n**Requeued** by pm-cockpit.' },
    ];
    expect(parseCockpitAnswer(comments, DECISION_ID)).toBeNull();
  });

  it('is deterministic: takes the OLDEST matching DecisionResponse when several are present', () => {
    const comments = [
      { body: decisionResponseComment(DECISION_ID, 'approve') }, // oldest
      { body: decisionResponseComment(DECISION_ID, 'reject') }, // newer (ignored)
    ];
    expect(parseCockpitAnswer(comments, DECISION_ID)?.choice).toBe('approve');
  });

  it('ignores a comment that says DecisionResponse but has no parseable matching JSON', () => {
    const comments = [
      { body: '**DecisionResponse** — answer recorded (protected, no plaintext).' },
    ];
    expect(parseCockpitAnswer(comments, DECISION_ID)).toBeNull();
  });

  it('tolerates null/empty comment bodies', () => {
    const comments = [
      { body: null },
      { body: '' },
      { body: decisionResponseComment(DECISION_ID, 'approve') },
    ];
    expect(parseCockpitAnswer(comments, DECISION_ID)?.choice).toBe('approve');
  });
});

describe('isDecisionOwnedIssue (detectReadyWork skip guard)', () => {
  it('skips an issue whose body carries the decision-request block marker', () => {
    const body =
      'Some feature.\n\n<!-- pm-cockpit:decision-request:v1 -->\n```json\n{}\n```\n<!-- /pm-cockpit:decision-request -->';
    expect(isDecisionOwnedIssue(body, 100, new Set())).toBe(true);
  });

  it('skips an issue whose number is in the live parked-decision set (body marker stripped/edited)', () => {
    expect(isDecisionOwnedIssue('no marker here', 100, new Set([100]))).toBe(
      true,
    );
  });

  it('does NOT skip a genuine fresh-work issue (no marker, not parked)', () => {
    expect(isDecisionOwnedIssue('fresh ready work', 200, new Set([100]))).toBe(
      false,
    );
  });

  it('skips on EITHER condition (union), and handles undefined body', () => {
    expect(isDecisionOwnedIssue(undefined, 100, new Set([100]))).toBe(true);
    expect(isDecisionOwnedIssue(undefined, 200, new Set())).toBe(false);
  });
});

describe('registry label vocab', () => {
  it('matches the live cockpit registry (requeue_label=ready, answered_label=answered)', () => {
    expect(REQUEUE_LABEL).toBe('ready');
    expect(ANSWERED_LABEL).toBe('answered');
  });
});
