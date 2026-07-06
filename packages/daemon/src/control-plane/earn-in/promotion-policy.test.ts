import { describe, it, expect } from 'vitest';
import { evaluatePromotion, floorsFailed } from './promotion-policy.js';
import { FLOOR_NAMES } from './floors.js';
import type { PromotionInput, PromotionTrackRecord } from './types.js';

const strongRecord = (): PromotionTrackRecord => ({
  bar: { cleanMerges: 12, bounceFreeDays: 40 },
  cleanMergesInWindow: 12,
  redEventInWindow: false,
});

const strongBar = () => ({ cleanMerges: 10, bounceFreeDays: 30 });

const baseInput = (over: Partial<PromotionInput> = {}): PromotionInput => ({
  record: strongRecord(),
  bar: strongBar(),
  preApproved: { enabled: true, policyRef: 'ops-pack-v1' },
  verifierFalsifying: true,
  scopeHolding: true,
  ...over,
});

describe('evaluatePromotion', () => {
  it('returns not-eligible when the bar is not met', () => {
    const res = evaluatePromotion(baseInput({
      record: { bar: { cleanMerges: 5, bounceFreeDays: 40 }, cleanMergesInWindow: 5, redEventInWindow: false },
    }));
    expect(res.kind).toBe('not-eligible');
  });

  it('auto-widens when bar is met, preApproved enabled, and all floors clear', () => {
    const res = evaluatePromotion(baseInput());
    expect(res.kind).toBe('auto-widen');
    if (res.kind === 'auto-widen') {
      expect(res.policyRef).toBe('ops-pack-v1');
      expect(new Set(res.clearedFloors)).toEqual(new Set(FLOOR_NAMES));
    }
  });

  it('raises a decision when preApproved is absent', () => {
    const res = evaluatePromotion(baseInput({ preApproved: undefined }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') expect(res.failedFloors).toEqual([]);
  });

  it('raises a decision when preApproved is disabled', () => {
    const res = evaluatePromotion(baseInput({ preApproved: { enabled: false, policyRef: 'x' } }));
    expect(res.kind).toBe('raise-decision');
  });

  it('raises a decision with bar-clean-merges-below-floor for a weak bar', () => {
    const res = evaluatePromotion(baseInput({ bar: { cleanMerges: 3, bounceFreeDays: 40 } }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('bar-clean-merges-below-floor');
    }
  });

  it('raises a decision with bar-recency-below-floor for a weak recency bar', () => {
    const res = evaluatePromotion(baseInput({ bar: { cleanMerges: 12, bounceFreeDays: 5 } }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('bar-recency-below-floor');
    }
  });

  it('returns not-eligible for a missing bar', () => {
    const res = evaluatePromotion(baseInput({ bar: undefined }));
    expect(res.kind).toBe('not-eligible');
  });

  it('raises a decision for red-in-window', () => {
    const res = evaluatePromotion(baseInput({ record: { ...strongRecord(), redEventInWindow: true } }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('red-in-window');
    }
  });

  it('raises a decision for insufficient recent clean merges', () => {
    const res = evaluatePromotion(baseInput({
      record: { bar: { cleanMerges: 12, bounceFreeDays: 40 }, cleanMergesInWindow: 5, redEventInWindow: false },
    }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('insufficient-recent-clean-merges');
    }
  });

  it('raises a decision when verifier is not falsifying', () => {
    const res = evaluatePromotion(baseInput({ verifierFalsifying: false }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('verifier-not-gated');
    }
  });

  it('raises a decision when scope is not holding', () => {
    const res = evaluatePromotion(baseInput({ scopeHolding: false }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('scope-not-holding');
    }
  });

  it('never auto-widens while any floor fails', () => {
    const variants: Partial<PromotionInput>[] = [
      { scopeHolding: false },
      { verifierFalsifying: false },
      { record: { ...strongRecord(), redEventInWindow: true } },
      { record: { bar: { cleanMerges: 12, bounceFreeDays: 40 }, cleanMergesInWindow: 5, redEventInWindow: false } },
      { bar: { cleanMerges: 3, bounceFreeDays: 40 } },
    ];
    for (const over of variants) {
      const res = evaluatePromotion(baseInput(over));
      expect(res.kind).not.toBe('auto-widen');
    }
  });
});

describe('floorsFailed', () => {
  it('never includes reversible', () => {
    const failed = floorsFailed(baseInput());
    expect(failed).not.toContain('reversible');
  });
});
