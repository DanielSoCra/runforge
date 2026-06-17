// packages/daemon/src/session-runtime/providers/window-scheduler/headroom.test.ts
import { describe, it, expect } from 'vitest';
import { TIGHT_FRACTION, headroomOrder, headroomFromEstimate } from './headroom.js';

describe('headroomOrder', () => {
  it('strictly orders exhausted(0) < unknown(1) < tight(2) < ample(3)', () => {
    expect(headroomOrder('exhausted')).toBe(0);
    expect(headroomOrder('unknown')).toBe(1);
    expect(headroomOrder('tight')).toBe(2);
    expect(headroomOrder('ample')).toBe(3);
    // strict monotonic chain
    expect(headroomOrder('exhausted')).toBeLessThan(headroomOrder('unknown'));
    expect(headroomOrder('unknown')).toBeLessThan(headroomOrder('tight'));
    expect(headroomOrder('tight')).toBeLessThan(headroomOrder('ample'));
  });
});

describe('headroomFromEstimate', () => {
  it('returns exhausted when estimate >= capacity', () => {
    expect(headroomFromEstimate(100, 100, true)).toBe('exhausted');
    expect(headroomFromEstimate(120, 100, true)).toBe('exhausted');
    // exhaustion holds even without evidence (it is the cautious direction)
    expect(headroomFromEstimate(100, 100, false)).toBe('exhausted');
  });

  it('never returns ample without evidence (caps at tight) even at low utilization', () => {
    // Below capacity but no evidence: must NOT be ample, even near-empty.
    expect(headroomFromEstimate(0, 100, false)).not.toBe('ample');
    expect(headroomFromEstimate(1, 100, false)).not.toBe('ample');
    // The L3 caps no-evidence below-capacity at tight.
    expect(headroomFromEstimate(0, 100, false)).toBe('tight');
  });

  it('with evidence: below TIGHT_FRACTION utilization → ample', () => {
    // Use a utilization strictly below the exported threshold (no hardcoded number).
    const capacity = 1000;
    const belowEstimate = Math.floor(capacity * TIGHT_FRACTION) - 1; // < TIGHT_FRACTION * capacity
    expect(belowEstimate).toBeGreaterThanOrEqual(0); // guard: threshold leaves room below it
    expect(headroomFromEstimate(belowEstimate, capacity, true)).toBe('ample');
  });

  it('with evidence: at/above TIGHT_FRACTION utilization (still below capacity) → tight', () => {
    const capacity = 1000;
    const atEstimate = Math.ceil(capacity * TIGHT_FRACTION); // >= TIGHT_FRACTION * capacity, < capacity
    expect(atEstimate).toBeLessThan(capacity); // guard: threshold is below full
    expect(headroomFromEstimate(atEstimate, capacity, true)).toBe('tight');
  });
});
