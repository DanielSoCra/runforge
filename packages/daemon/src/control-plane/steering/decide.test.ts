// packages/daemon/src/control-plane/steering/decide.test.ts
//
// IMMOVABLE acceptance contract for the two pure deciders. All behavioral —
// these FAIL (red) at handoff because decideWake / checkSpend throw
// 'not implemented'. Kimi fills the bodies to make them pass; the tests may NOT
// be weakened. Pure over a frozen role + a passed-in snapshot/spend (no clock).
import { describe, it, expect } from 'vitest';
import { decideWake, checkSpend } from './decide.js';
import type { SteeringRole } from './types.js';

function makeRole(over: Partial<SteeringRole> = {}): SteeringRole {
  return {
    id: 'product-owner',
    charter: 'own product shape',
    instructions: 'scan and shape',
    voice: 'pragmatic',
    capabilityGrant: ['classifier'],
    referenceKnowledge: ['roadmap'],
    routingGrant: ['research', 'operator-proposal'],
    wakeRhythm: { kind: 'interval', everyMs: 1000 },
    perWakingBudget: 5000,
    ...over,
  };
}

describe('decideWake (pure over the snapshot)', () => {
  it('first-ever wake (lastWakingAt undefined) → due', () => {
    const r = decideWake(makeRole(), { now: 10_000 });
    expect(r.kind).toBe('due');
  });

  it('interval NOT elapsed (now - lastWakingAt < everyMs) → not-due', () => {
    const role = makeRole({ wakeRhythm: { kind: 'interval', everyMs: 1000 } });
    const r = decideWake(role, { now: 10_500, lastWakingAt: 10_000 });
    expect(r.kind).toBe('not-due');
  });

  it('interval elapsed (now - lastWakingAt >= everyMs) → due', () => {
    const role = makeRole({ wakeRhythm: { kind: 'interval', everyMs: 1000 } });
    const r = decideWake(role, { now: 11_000, lastWakingAt: 10_000 });
    expect(r.kind).toBe('due');
  });

  it('interval exactly elapsed (== everyMs) → due (boundary is inclusive)', () => {
    const role = makeRole({ wakeRhythm: { kind: 'interval', everyMs: 1000 } });
    const r = decideWake(role, { now: 11_000, lastWakingAt: 10_000 });
    expect(r.kind).toBe('due');
  });
});

describe('checkSpend (bounded by the declared budget)', () => {
  it('runningSpend < budget → proceed', () => {
    const r = checkSpend(makeRole({ perWakingBudget: 5000 }), 4999);
    expect(r.kind).toBe('proceed');
  });

  it('runningSpend == budget → conclude-and-record (the over-budget cautious arm)', () => {
    const r = checkSpend(makeRole({ perWakingBudget: 5000 }), 5000);
    expect(r.kind).toBe('conclude-and-record');
  });

  it('runningSpend > budget → conclude-and-record (never overspends)', () => {
    const r = checkSpend(makeRole({ perWakingBudget: 5000 }), 6000);
    expect(r.kind).toBe('conclude-and-record');
    if (r.kind === 'conclude-and-record') expect(r.reason.length).toBeGreaterThan(0);
  });

  // codex 2026-06-17: PROJECTED spend — a step must not push the waking over budget.
  it('under budget but the next step would exceed → conclude-and-record (projected)', () => {
    const r = checkSpend(makeRole({ perWakingBudget: 5000 }), 4900, 200); // 5100 projected
    expect(r.kind).toBe('conclude-and-record');
  });

  it('under budget and the next step stays within → proceed', () => {
    const r = checkSpend(makeRole({ perWakingBudget: 5000 }), 4900, 50); // 4950 projected
    expect(r.kind).toBe('proceed');
  });

  // codex round 4: a step that EXACTLY fits the remaining budget is allowed —
  // conclude only on STRICT overspend, never strand the last unit.
  it('a step that exactly fits the remaining budget → proceed', () => {
    const r = checkSpend(makeRole({ perWakingBudget: 5000 }), 4900, 100); // 5000 == budget
    expect(r.kind).toBe('proceed');
  });
});
