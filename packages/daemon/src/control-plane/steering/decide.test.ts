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

  // ── cron rhythm (re-enabled, follow-up #15) ───────────────────────────────
  // RED until the implementer wires the cron arm to call cronDue. The cron arm
  // must delegate to the pure evaluator — NOT keep returning the old fixed
  // "cron not supported" not-due.
  it('cron rhythm whose fire elapsed in the window → due', () => {
    // Hourly cron; last waking at 08:30, now at 09:30 → the 09:00 fire lies inside
    // (08:30, 09:30] → due.
    const role = makeRole({ wakeRhythm: { kind: 'cron', expr: '0 * * * *' } });
    const r = decideWake(role, {
      now: Date.UTC(2024, 0, 1, 9, 30),
      lastWakingAt: Date.UTC(2024, 0, 1, 8, 30),
    });
    expect(r.kind).toBe('due');
  });

  it('cron rhythm with no fire in the window → not-due', () => {
    // Hourly cron; last waking at 09:05, now at 09:55 → no HH:00 minute in
    // (09:05, 09:55] → not-due (a real cron evaluation, not the old fixed reject).
    const role = makeRole({ wakeRhythm: { kind: 'cron', expr: '0 * * * *' } });
    const r = decideWake(role, {
      now: Date.UTC(2024, 0, 1, 9, 55),
      lastWakingAt: Date.UTC(2024, 0, 1, 9, 5),
    });
    expect(r.kind).toBe('not-due');
  });

  it('first-ever cron wake at a matching minute → due', () => {
    // lastWakingAt undefined, now exactly at the 09:00 daily fire → due via the
    // one-minute lookback (the cron analogue of "first-ever interval is due").
    const role = makeRole({ wakeRhythm: { kind: 'cron', expr: '0 9 * * *' } });
    const r = decideWake(role, { now: Date.UTC(2024, 0, 1, 9, 0) });
    expect(r.kind).toBe('due');
  });

  it('first-ever cron wake at a NON-matching minute → due (initial scan, codex round 4)', () => {
    // lastWakingAt undefined, now at 10:00 while the role fires daily at 09:00. The
    // rhythm-agnostic "first-ever is due" rule (this is the role's INITIAL scan on
    // activation) makes this due — a newly activated cron role must NOT sit idle
    // until tomorrow's 09:00 fire. The first-ever rule lives in decideWake's cron
    // arm, above cronDue's primitive one-minute lookback.
    const role = makeRole({ wakeRhythm: { kind: 'cron', expr: '0 9 * * *' } });
    const r = decideWake(role, { now: Date.UTC(2024, 0, 1, 10, 0) });
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
