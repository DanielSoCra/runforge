import { describe, it, expect } from 'vitest';
import {
  parseCockpitAnswer,
  isDecisionOwnedIssue,
  REQUEUE_LABEL,
  ANSWERED_LABEL,
} from './resume-consumer.js';

/**
 * resume-consumer — the daemon-side recognition of the pm-cockpit answer write-back.
 * These tests pin the PARSING contract against the cockpit's REAL byte format
 * (mirrored from pm-cockpit github-source-sink.ts `renderAnswerComment` + the
 * canonical `effectId(decisionId, kind, semanticKey)` = `<decision_id>:<kind>:<semantic_key>`
 * in @pm/index idempotency.ts):
 *   - an effect marker `<!-- pm-cockpit:effect:<decisionId>:write_response:<idemKey>:etag=<etag> -->`
 *     — the decision_id binding is carried HERE, authoritatively.
 *   - `**DecisionResponse**` followed by a fenced ```json payload that is MINIMAL:
 *     `{"chosen_option":"approve"|"reject"}` (it does NOT carry decision_id /
 *     answerer / answered_at / idempotency_key — those live in the marker / cockpit DB).
 *   - the decision-request body block marker `<!-- pm-cockpit:decision-request:v1 -->`.
 *   - the requeue comment marker `<!-- pm-cockpit:requeue:<effectId> -->`.
 *
 * The AUTHORITATIVE resume signal is the DecisionResponse comment whose effect
 * marker binds `pm-cockpit:effect:<decisionId>:write_response` — NOT the
 * `answered`/`ready` labels (those are discovery/cleanup hints only). A half-written
 * answer (label flipped, comment not yet posted, or vice-versa) must NOT resume.
 */

const DECISION_ID = 'issue-100:l2-gate:1';

/**
 * Build the cockpit's REAL DecisionResponse comment body for a chosen option.
 * Mirrors github-source-sink.ts: marker = effectMarker(effectId, etag) where
 * effectId = `<decisionId>:write_response:<semanticKey>` (semanticKey =
 * response_idempotency_key), then `**DecisionResponse**`, then a fenced ```json
 * carrying ONLY `{ chosen_option }`.
 */
function decisionResponseComment(
  decisionId: string,
  chosenOption: string,
  etag = 'sha256:etag-abc',
  semanticKey = 'idem-key-1',
): string {
  const effectId = `${decisionId}:write_response:${semanticKey}`;
  const marker = `<!-- pm-cockpit:effect:${effectId}:etag=${etag} -->`;
  const payload = JSON.stringify({ chosen_option: chosenOption });
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

  it('recognizes the legacy integrate `approve-merge` id as approve but preserves the RAW id for the ledger (rollout compat, codex)', () => {
    // A run parked under the pre-rename integrate option id has a stored request
    // whose approve option is `approve-merge`; the cockpit answers with that id.
    // It must resume as a semantic `approve` (routing) AND carry the raw id so the
    // daemon answers the ledger with `approve-merge` — the decision-index state
    // machine validates the answered id against the stored options[].
    const comments = [
      { body: decisionResponseComment(DECISION_ID, 'approve-merge') },
    ];
    const result = parseCockpitAnswer(comments, DECISION_ID);
    expect(result?.choice).toBe('approve');
    expect(result?.rawChosenOption).toBe('approve-merge');
  });

  it('carries the raw chosen_option verbatim for a current `approve` id too', () => {
    const comments = [{ body: decisionResponseComment(DECISION_ID, 'approve') }];
    const result = parseCockpitAnswer(comments, DECISION_ID);
    expect(result?.choice).toBe('approve');
    expect(result?.rawChosenOption).toBe('approve');
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

  it('GROUND TRUTH: recognizes the EXACT live cockpit writeback (issue-3, minimal JSON, decision_id only in the marker)', () => {
    // Byte-for-byte from DANIELSOCRAHANDLEZZ/pm-cockpit-selftest#3 (live).
    const liveBody = [
      '<!-- pm-cockpit:effect:issue-3:l2-gate:1:write_response:e2e-approve-1:etag=sha256:d7a8087139a57f7bda694297df63bcad6b29b24b3ab73864af732a0ba2ca3448 -->',
      '**DecisionResponse**',
      '```json',
      '{"chosen_option":"approve"}',
      '```',
    ].join('\n');
    const result = parseCockpitAnswer([{ body: liveBody }], 'issue-3:l2-gate:1');
    expect(result).toEqual({
      choice: 'approve',
      rawChosenOption: 'approve',
      feedbackBody: liveBody,
    });
  });

  it('does NOT match a different decision_id even when the minimal JSON is identical (marker binds the id)', () => {
    // Two issues could both post `{"chosen_option":"approve"}`; only the marker
    // disambiguates which run the answer belongs to.
    const other = decisionResponseComment('issue-100:l2-gate:2', 'approve');
    expect(parseCockpitAnswer([{ body: other }], DECISION_ID)).toBeNull();
  });

  it('does NOT match a prefix-overlapping decision_id (marker boundary is :write_response)', () => {
    // `issue-100:l2-gate:1` must not match a marker for `issue-100:l2-gate:12`.
    const longer = decisionResponseComment('issue-100:l2-gate:12', 'approve');
    expect(parseCockpitAnswer([{ body: longer }], DECISION_ID)).toBeNull();
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
