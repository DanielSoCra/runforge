// packages/daemon/src/control-plane/lane-engine/earn-in.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateEarnIn } from './earn-in.js';

describe('evaluateEarnIn', () => {
  const policy = { cleanMerges: 10, bounceFreeDays: 3 };

  it('is eligible when the record meets the bar', () => {
    const r = evaluateEarnIn({ cleanMerges: 12, bounceFreeDays: 5 }, policy);
    expect(r.kind).toBe('eligible-for-promotion');
  });

  it('is not eligible when cleanMerges is short, with a reason', () => {
    const r = evaluateEarnIn({ cleanMerges: 4, bounceFreeDays: 5 }, policy);
    expect(r.kind).toBe('not-eligible');
    if (r.kind === 'not-eligible') expect(r.reasons.join()).toContain('cleanMerges');
  });

  it('is not eligible when bounceFreeDays is short', () => {
    const r = evaluateEarnIn({ cleanMerges: 20, bounceFreeDays: 1 }, policy);
    expect(r.kind).toBe('not-eligible');
    if (r.kind === 'not-eligible') expect(r.reasons.join()).toContain('bounceFreeDays');
  });

  it('is not eligible when the lane declares no earn-in policy', () => {
    const r = evaluateEarnIn({ cleanMerges: 999, bounceFreeDays: 999 }, undefined);
    expect(r.kind).toBe('not-eligible');
  });
});
