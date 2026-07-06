import { describe, it, expect } from 'vitest';
import { planMint } from './mint.js';
import type { MintInput, PromotionResult, PromotionTrackRecord } from './types.js';

const strongRecord = (): PromotionTrackRecord => ({
  bar: { cleanMerges: 12, bounceFreeDays: 40 },
  cleanMergesInWindow: 12,
  redEventInWindow: false,
});

const autoWiden = (over: Partial<Extract<PromotionResult, { kind: 'auto-widen' }>> = {}): PromotionResult => ({
  kind: 'auto-widen',
  clearedFloors: [
    'bar-clean-merges-below-floor',
    'bar-recency-below-floor',
    'insufficient-recent-clean-merges',
    'red-in-window',
    'scope-not-holding',
    'verifier-not-gated',
    'reversible',
  ],
  evidence: strongRecord(),
  policyRef: 'ops-pack-v1',
  ...over,
});

const baseInput = (over: Partial<MintInput> = {}): MintInput => ({
  promotion: autoWiden(),
  effectiveRisk: 'green',
  verifierFalsifying: true,
  complianceForced: false,
  currentlyHumanGated: true,
  isDebut: false,
  hasDebutAuthorization: false,
  ...over,
});

describe('planMint', () => {
  it('mints when auto-widen + all guards clear + not-debut', () => {
    const plan = planMint(baseInput());
    expect(plan.kind).toBe('mint');
    if (plan.kind === 'mint') {
      expect(plan.level).toBe('green');
      expect(plan.policyRef).toBe('ops-pack-v1');
      expect(plan.evidence).toEqual({
        cleanMerges: 12,
        cleanMergesInWindow: 12,
        bounceFreeDays: 40,
        redEventInWindow: false,
      });
    }
  });

  it('withholds the debut when isDebut and not authorized', () => {
    const plan = planMint(baseInput({ isDebut: true, hasDebutAuthorization: false }));
    expect(plan.kind).toBe('withhold-debut');
  });

  it('skips when already widened (idempotent)', () => {
    const plan = planMint(baseInput({ currentlyHumanGated: false }));
    expect(plan.kind).toBe('skip');
  });

  it('skips for orange/red risk', () => {
    expect(planMint(baseInput({ effectiveRisk: 'orange' })).kind).toBe('skip');
    expect(planMint(baseInput({ effectiveRisk: 'red' })).kind).toBe('skip');
  });

  it('skips when compliance is forced', () => {
    expect(planMint(baseInput({ complianceForced: true })).kind).toBe('skip');
  });

  it('skips when verifier is not falsifying', () => {
    expect(planMint(baseInput({ verifierFalsifying: false })).kind).toBe('skip');
  });

  it('skips for a raise-decision evaluation', () => {
    const plan = planMint(baseInput({ promotion: { kind: 'raise-decision', failedFloors: ['red-in-window'] } }));
    expect(plan.kind).toBe('skip');
  });
});
