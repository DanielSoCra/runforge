import { describe, it, expect } from 'vitest';
import {
  DecisionRequestSchema,
  PROTOCOL_VERSION,
} from '@auto-claude/decision-protocol';
import type { RunState } from '../../types.js';
import { buildL2GateRequest, decisionIdFor } from './build-request.js';

const FIXED_NOW = '2026-06-02T00:00:00.000Z';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-uuid-1234',
    issueNumber: 42,
    title: 'Add the widget',
    phase: 'l2-gate',
    variant: 'spec-driven',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    repoOwner: 'DANIELSOCRAHANDLEZZ',
    repoName: 'auto-claude',
    startedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    workerClaimId: 'claim-abc',
    ...overrides,
  };
}

describe('decisionIdFor', () => {
  it('is deterministic: `${runRef}:${phase}:${epoch}`', () => {
    expect(decisionIdFor('issue-42', 'l2-gate', 1)).toBe('issue-42:l2-gate:1');
    expect(decisionIdFor('issue-7', 'l2-gate', 3)).toBe('issue-7:l2-gate:3');
  });

  it('differs by epoch', () => {
    expect(decisionIdFor('issue-42', 'l2-gate', 1)).not.toBe(
      decisionIdFor('issue-42', 'l2-gate', 2),
    );
  });
});

describe('buildL2GateRequest', () => {
  it('produces an object the REAL DecisionRequestSchema accepts', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'auto-claude', { now: FIXED_NOW });
    const parsed = DecisionRequestSchema.parse(req);
    expect(parsed.decision_id).toBe('issue-42:l2-gate:1');
  });

  it('deterministic decision_id = issue-<n>:l2-gate:<epoch>; idempotency_key derived from it', () => {
    const req = buildL2GateRequest(makeRun(), 5, 'auto-claude', { now: FIXED_NOW });
    expect(req.decision_id).toBe('issue-42:l2-gate:5');
    expect(req.idempotency_key).toBe('issue-42:l2-gate:5');
  });

  it('epoch 1 id !== epoch 2 id', () => {
    const e1 = buildL2GateRequest(makeRun(), 1, 'auto-claude', { now: FIXED_NOW });
    const e2 = buildL2GateRequest(makeRun(), 2, 'auto-claude', { now: FIXED_NOW });
    expect(e1.decision_id).not.toBe(e2.decision_id);
    expect(e1.idempotency_key).not.toBe(e2.idempotency_key);
  });

  it('options are exactly approve/reject; answer_schema is option', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'auto-claude', { now: FIXED_NOW });
    expect(req.options).toEqual([
      { id: 'approve', label: expect.any(String) },
      { id: 'reject', label: expect.any(String) },
    ]);
    expect(req.answer_schema).toEqual({ kind: 'option' });
  });

  it('resume_mode=requeue, risk_class=P1, reversibility=reversible', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'auto-claude', { now: FIXED_NOW });
    expect(req.resume_mode).toBe('requeue');
    expect(req.risk_class).toBe('P1');
    expect(req.reversibility).toBe('reversible');
  });

  it('protocol_version is set', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'auto-claude', { now: FIXED_NOW });
    expect(req.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it('field mapping: run_id, worker_session_id, phase, deployment, source_url', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'prod-deploy', { now: FIXED_NOW });
    expect(req.run_id).toBe('issue-42');
    expect(req.worker_session_id).toBe('claim-abc');
    expect(req.phase).toBe('l2-gate');
    expect(req.deployment).toBe('prod-deploy');
    expect(req.source_url).toBe('https://github.com/DANIELSOCRAHANDLEZZ/auto-claude/issues/42');
  });

  it('worker_session_id falls back to run-<issueNumber> when no workerClaimId', () => {
    const req = buildL2GateRequest(
      makeRun({ workerClaimId: undefined }),
      1,
      'auto-claude',
      { now: FIXED_NOW },
    );
    expect(req.worker_session_id).toBe('run-42');
  });

  it('expires_at defaults to now + 7 days (ISO)', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'auto-claude', { now: FIXED_NOW });
    expect(req.expires_at).toBe('2026-06-09T00:00:00.000Z');
  });

  it('opts.expiresAt and opts.sourceUrl override the defaults', () => {
    const req = buildL2GateRequest(makeRun(), 1, 'auto-claude', {
      now: FIXED_NOW,
      expiresAt: '2030-01-01T00:00:00.000Z',
      sourceUrl: 'https://example.test/pr/9',
    });
    expect(req.expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(req.source_url).toBe('https://example.test/pr/9');
  });

  it('context + question contain ONLY structured known-safe text — no raw run feedback', () => {
    const secret = 'SENSITIVE-RAW-FAILURE-abc123';
    const req = buildL2GateRequest(
      makeRun({
        l2Feedback: secret,
        handoffNotes: { 'l2-design': secret },
        report: secret,
      }),
      1,
      'auto-claude',
      { now: FIXED_NOW },
    );
    expect(req.context).not.toContain(secret);
    expect(req.question).not.toContain(secret);
    // structured, known references only
    expect(req.context).toContain('42');
    expect(req.context).toContain('l2-gate');
  });
});
