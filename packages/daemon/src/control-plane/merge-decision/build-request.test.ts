// packages/daemon/src/control-plane/merge-decision/build-request.test.ts
//
// IMMOVABLE acceptance contract for buildMergeDecisionRequest (slice 5b, pure
// builder). Mirrors decision-escalation/build-request.test.ts: the built object
// must parse through the REAL DecisionRequestSchema (the schema IS the gate —
// never a hand-maintained field list).
//
// RED at handoff: the body throws 'not implemented'. Kimi fills it green.
import { describe, it, expect } from 'vitest';
import {
  DecisionRequestSchema,
  PROTOCOL_VERSION,
} from '@auto-claude/decision-protocol';
import type { RunState } from '../../types.js';
import { buildMergeDecisionRequest, decisionIdFor } from './build-request.js';
import type { MergeDecision } from './types.js';
import type {
  Eligibility,
  LaneAssignmentResult,
  ModeResolution,
  ResolvedLane,
  RiskLevel,
} from '../lane-engine/types.js';
import type { VerifierGateResult } from '../lane-engine/verifier-gate/types.js';

const FIXED_NOW = '2026-06-02T00:00:00.000Z';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-uuid-1234',
    issueNumber: 42,
    title: 'Add the widget',
    phase: 'integrate',
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

const lane: ResolvedLane = {
  name: 'auto',
  qualify: { complexity: ['simple'] },
  allowedPaths: ['docs/**'],
  roleRouting: {},
  gateSet: 'gate1',
  mergePolicy: 'auto',
  verifier: { kind: 'test-suite', invoke: { ref: 'pnpm test' } },
};
const modeResolution: ModeResolution = { mode: 'velocity', degraded: false };
const verifierGate: VerifierGateResult = { kind: 'verifier-gated' };
const assignment: LaneAssignmentResult = { kind: 'assigned', lane: 'auto', reasons: [] };
const eligibility: Eligibility = {
  kind: 'eligible',
  effectiveRisk: 'green',
  gateSet: 'gate1',
  mergePolicy: 'auto',
  tripwire: { kind: 'in-scope', touched: ['docs/x.md'] },
  modeResolution,
};

/** An escalate decision at a given effective-risk level (drives risk_class). */
function escalateDecision(effectiveRisk: RiskLevel): MergeDecision {
  return {
    kind: 'escalate',
    reason: 'autonomy-not-widened',
    lane,
    effectiveRisk,
    assignment,
    eligibility,
    verifierGate,
    modeResolution,
  };
}

describe('decisionIdFor (merge-decision)', () => {
  it('is deterministic: `${runRef}:integrate:${epoch}`', () => {
    expect(decisionIdFor('issue-42', 1)).toBe('issue-42:integrate:1');
    expect(decisionIdFor('issue-7', 3)).toBe('issue-7:integrate:3');
  });

  it('differs by epoch', () => {
    expect(decisionIdFor('issue-42', 1)).not.toBe(decisionIdFor('issue-42', 2));
  });
});

describe('buildMergeDecisionRequest', () => {
  it('produces an object the REAL DecisionRequestSchema accepts', () => {
    const req = buildMergeDecisionRequest(makeRun(), 1, 'auto-claude', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    const parsed = DecisionRequestSchema.parse(req);
    expect(parsed.decision_id).toBe('issue-42:integrate:1');
    expect(parsed.phase).toBe('integrate');
  });

  it('deterministic decision_id = issue-<n>:integrate:<epoch>; idempotency_key derived from it', () => {
    const req = buildMergeDecisionRequest(makeRun(), 5, 'auto-claude', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    expect(req.decision_id).toBe('issue-42:integrate:5');
    expect(req.idempotency_key).toBe('issue-42:integrate:5');
  });

  it('epoch 1 id !== epoch 2 id', () => {
    const e1 = buildMergeDecisionRequest(makeRun(), 1, 'auto-claude', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    const e2 = buildMergeDecisionRequest(makeRun(), 2, 'auto-claude', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    expect(e1.decision_id).not.toBe(e2.decision_id);
    expect(e1.idempotency_key).not.toBe(e2.idempotency_key);
  });

  it('risk_class is derived from the decision effective risk via toDecisionRiskClass', () => {
    // green→P3, yellow→P2, orange→P1, red→P0 (the one place the lane-RiskLevel
    // vocabulary maps onto the P-class vocabulary). This is the load-bearing
    // difference from the l2-gate request (which hardcodes P1).
    const cases: Array<[RiskLevel, 'P0' | 'P1' | 'P2' | 'P3']> = [
      ['green', 'P3'],
      ['yellow', 'P2'],
      ['orange', 'P1'],
      ['red', 'P0'],
    ];
    for (const [level, expected] of cases) {
      const req = buildMergeDecisionRequest(makeRun(), 1, 'auto-claude', escalateDecision(level), {
        now: FIXED_NOW,
      });
      expect(req.risk_class).toBe(expected);
    }
  });

  it('answer_schema is option; resume_mode=requeue; reversibility=reversible', () => {
    const req = buildMergeDecisionRequest(makeRun(), 1, 'auto-claude', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    expect(req.answer_schema).toEqual({ kind: 'option' });
    expect(req.resume_mode).toBe('requeue');
    expect(req.reversibility).toBe('reversible');
    expect(req.options.length).toBeGreaterThanOrEqual(1);
  });

  it('protocol_version is set', () => {
    const req = buildMergeDecisionRequest(makeRun(), 1, 'auto-claude', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    expect(req.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it('field mapping: run_id, worker_session_id, phase, deployment, source_url', () => {
    const req = buildMergeDecisionRequest(makeRun(), 1, 'prod-deploy', escalateDecision('green'), {
      now: FIXED_NOW,
    });
    expect(req.run_id).toBe('issue-42');
    expect(req.worker_session_id).toBe('claim-abc');
    expect(req.phase).toBe('integrate');
    expect(req.deployment).toBe('prod-deploy');
    expect(req.source_url).toBe('https://github.com/DANIELSOCRAHANDLEZZ/auto-claude/issues/42');
  });

  it('worker_session_id falls back to run-<issueNumber> when no workerClaimId', () => {
    const req = buildMergeDecisionRequest(
      makeRun({ workerClaimId: undefined }),
      1,
      'auto-claude',
      escalateDecision('green'),
      { now: FIXED_NOW },
    );
    expect(req.worker_session_id).toBe('run-42');
  });

  it('context + question contain ONLY structured known-safe text — no raw run feedback', () => {
    const secret = 'SENSITIVE-RAW-FAILURE-abc123';
    const req = buildMergeDecisionRequest(
      makeRun({ l2Feedback: secret, handoffNotes: { 'l2-design': secret }, report: secret }),
      1,
      'auto-claude',
      escalateDecision('green'),
      { now: FIXED_NOW },
    );
    expect(req.context).not.toContain(secret);
    expect(req.question).not.toContain(secret);
    // structured, known references only
    expect(req.context).toContain('42');
    expect(req.context).toContain('integrate');
  });
});
