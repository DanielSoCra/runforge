// finding-dismissal/build-request.test.ts — the IMMOVABLE acceptance contract.
// The built object must parse through the REAL DecisionRequestSchema; the id is
// the strict, REPO-SCOPED machine-readable carrier of phase + category.
import { describe, it, expect } from 'vitest';
import {
  DecisionRequestSchema,
  PROTOCOL_VERSION,
} from '@auto-claude/decision-protocol';
import {
  buildFindingDismissalRequest,
  buildFindingDismissalDecisionId,
  parseFindingDismissalDecisionId,
  isFindingDismissalDecisionId,
  findingIssueUrl,
  FINDING_DISMISSAL_PHASE,
} from './build-request.js';

const FIXED_NOW = '2026-06-30T00:00:00.000Z';

describe('buildFindingDismissalDecisionId / parse round-trip', () => {
  it('builds the strict repo-scoped finding-<owner>/<repo>#<issue>:finding-dismissal:<category>:<epoch> id', () => {
    expect(buildFindingDismissalDecisionId('acme', 'widgets', 42, 'correctness', 7)).toBe(
      'finding-acme/widgets#42:finding-dismissal:correctness:7',
    );
  });

  it('parses a well-formed id back to {owner, repo, issue, category, epoch}', () => {
    expect(parseFindingDismissalDecisionId('finding-acme/widgets#42:finding-dismissal:security:3')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      category: 'security',
      epoch: 3,
    });
  });

  it('REPO-SCOPED: same issue#/category/epoch in two repos → DISTINCT ids (no cross-repo collision)', () => {
    const a = buildFindingDismissalDecisionId('acme', 'widgets', 42, 'correctness', 1);
    const b = buildFindingDismissalDecisionId('other', 'repo', 42, 'correctness', 1);
    expect(a).not.toBe(b);
    expect(parseFindingDismissalDecisionId(a)).toMatchObject({ owner: 'acme', repo: 'widgets' });
    expect(parseFindingDismissalDecisionId(b)).toMatchObject({ owner: 'other', repo: 'repo' });
  });

  it('returns null for a malformed / short / wrong-phase / unknown-category id', () => {
    expect(parseFindingDismissalDecisionId('finding-acme/widgets#42:finding-dismissal:security')).toBeNull(); // short
    expect(parseFindingDismissalDecisionId('issue-42:l2-gate:1')).toBeNull(); // wrong phase
    expect(parseFindingDismissalDecisionId('issue-9:integrate:1')).toBeNull(); // wrong phase
    expect(parseFindingDismissalDecisionId('finding-acme/widgets#42:finding-dismissal:bogus:1')).toBeNull(); // bad category
    expect(parseFindingDismissalDecisionId('finding-acme/widgets#x:finding-dismissal:security:1')).toBeNull(); // non-numeric issue
    expect(parseFindingDismissalDecisionId('finding-acme/widgets#42:finding-dismissal:security:x')).toBeNull(); // non-numeric epoch
    expect(parseFindingDismissalDecisionId('finding-42:finding-dismissal:security:1')).toBeNull(); // no owner/repo namespace
    expect(parseFindingDismissalDecisionId('finding-acmewidgets#42:finding-dismissal:security:1')).toBeNull(); // no slash
    expect(parseFindingDismissalDecisionId('')).toBeNull();
  });

  it('isFindingDismissalDecisionId matches finding ids only', () => {
    expect(isFindingDismissalDecisionId('finding-acme/widgets#42:finding-dismissal:correctness:1')).toBe(true);
    expect(isFindingDismissalDecisionId('issue-42:l2-gate:1')).toBe(false);
    expect(isFindingDismissalDecisionId('issue-9:integrate:1')).toBe(false);
  });
});

describe('buildFindingDismissalRequest', () => {
  const built = buildFindingDismissalRequest({
    issueNumber: 42,
    category: 'correctness',
    owner: 'acme',
    repo: 'widgets',
    riskClass: 'P1',
    epoch: 1,
    now: FIXED_NOW,
  });

  it('parses through the REAL DecisionRequestSchema (the schema is the gate)', () => {
    expect(() => DecisionRequestSchema.parse(built)).not.toThrow();
    expect(built.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it('uses the strict repo-scoped decision_id (= idempotency_key) and finding-dismissal phase', () => {
    expect(built.decision_id).toBe('finding-acme/widgets#42:finding-dismissal:correctness:1');
    expect(built.idempotency_key).toBe(built.decision_id);
    expect(built.phase).toBe(FINDING_DISMISSAL_PHASE);
  });

  it('carries the binary keep(approve)/dismiss(reject) options', () => {
    expect(built.options).toEqual([
      { id: 'approve', label: 'Keep the finding' },
      { id: 'reject', label: 'Dismiss the finding' },
    ]);
  });

  it('uses a synthetic repo-scoped run_id and worker_session_id (no real run)', () => {
    expect(built.run_id).toBe('finding-acme/widgets#42');
    expect(built.worker_session_id).toBe('finding-dismissal-42');
  });

  it('derives deployment + source_url from owner/repo/issue', () => {
    expect(built.deployment).toBe('acme/widgets');
    expect(built.source_url).toBe(findingIssueUrl('acme', 'widgets', 42));
  });

  it('takes risk_class from severity', () => {
    const p0 = buildFindingDismissalRequest({
      issueNumber: 7,
      category: 'security',
      owner: 'acme',
      repo: 'widgets',
      riskClass: 'P0',
      epoch: 1,
      now: FIXED_NOW,
    });
    expect(p0.risk_class).toBe('P0');
  });

  it('leaves recommended_option UNSET when no pre-fill is passed (rung-1 shape)', () => {
    expect(built.recommended_option).toBeUndefined();
  });

  it('does not leak free-text into context/question (structured only)', () => {
    expect(built.context).not.toContain('\n');
    expect(built.question).toContain('#42');
  });
});

describe('buildFindingDismissalRequest — rung-2 pre-fill (PR2)', () => {
  const REASON = 'Recommended: dismiss — learned from your consistent prior decisions in this category (confidence 82%).';

  it('sets recommended_option and attaches the reason as detail on the RECOMMENDED (reject) option', () => {
    const built = buildFindingDismissalRequest({
      issueNumber: 42,
      category: 'correctness',
      owner: 'acme',
      repo: 'widgets',
      riskClass: 'P1',
      epoch: 1,
      now: FIXED_NOW,
      recommendedOption: 'reject',
      recommendedReason: REASON,
    });
    // the schema is the gate — it must still parse.
    expect(() => DecisionRequestSchema.parse(built)).not.toThrow();
    expect(built.recommended_option).toBe('reject');
    // the reason rides ONLY the recommended option's detail; the other stays plain.
    const reject = built.options.find((o) => o.id === 'reject')!;
    const approve = built.options.find((o) => o.id === 'approve')!;
    expect(reject.detail).toBe(REASON);
    expect(approve.detail).toBeUndefined();
    // ids unchanged.
    expect(built.options.map((o) => o.id)).toEqual(['approve', 'reject']);
  });

  it('attaches the reason to the approve option when approve is recommended', () => {
    const built = buildFindingDismissalRequest({
      issueNumber: 7,
      category: 'performance',
      owner: 'acme',
      repo: 'widgets',
      riskClass: 'P2',
      epoch: 1,
      now: FIXED_NOW,
      recommendedOption: 'approve',
      recommendedReason: 'Recommended: keep — reason.',
    });
    expect(built.recommended_option).toBe('approve');
    expect(built.options.find((o) => o.id === 'approve')!.detail).toBe('Recommended: keep — reason.');
    expect(built.options.find((o) => o.id === 'reject')!.detail).toBeUndefined();
  });

  it('BYTE-IDENTICAL to the PR1 (no-pre-fill) output when recommendedOption is absent', () => {
    const withoutArgs = buildFindingDismissalRequest({
      issueNumber: 42,
      category: 'correctness',
      owner: 'acme',
      repo: 'widgets',
      riskClass: 'P1',
      epoch: 1,
      now: FIXED_NOW,
    });
    // Passing undefined pre-fill fields must be indistinguishable from omitting them.
    const withUndefined = buildFindingDismissalRequest({
      issueNumber: 42,
      category: 'correctness',
      owner: 'acme',
      repo: 'widgets',
      riskClass: 'P1',
      epoch: 1,
      now: FIXED_NOW,
      recommendedOption: undefined,
      recommendedReason: undefined,
    });
    expect(withUndefined).toEqual(withoutArgs);
    expect(withoutArgs.recommended_option).toBeUndefined();
    expect(withoutArgs.options.every((o) => o.detail === undefined)).toBe(true);
    // stable serialization — no stray keys.
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutArgs));
  });
});
