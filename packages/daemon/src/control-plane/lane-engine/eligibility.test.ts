// packages/daemon/src/control-plane/lane-engine/eligibility.test.ts
import { describe, it, expect } from 'vitest';
import { capPolicy, evaluateMergeEligibility } from './eligibility.js';
import type { EligibilityInput, ResolvedLane } from './types.js';

function makeLane(over: Partial<ResolvedLane> = {}): ResolvedLane {
  return {
    name: 'trivial',
    qualify: {},
    allowedPaths: ['docs/**'],
    roleRouting: {},
    gateSet: 'gate1',
    mergePolicy: 'auto',
    ...over,
  };
}

describe('capPolicy', () => {
  it('leaves green-eligible auto as auto', () => {
    expect(capPolicy('auto', 'green')).toBe('auto');
  });
  it('caps auto to review-then-auto at yellow', () => {
    expect(capPolicy('auto', 'yellow')).toBe('review-then-auto');
  });
  it('caps any policy to hold at orange and red', () => {
    expect(capPolicy('auto', 'orange')).toBe('hold');
    expect(capPolicy('review-then-auto', 'red')).toBe('hold');
  });
  it('never loosens a lane that is already more cautious', () => {
    expect(capPolicy('hold', 'green')).toBe('hold');
  });
});

describe('evaluateMergeEligibility', () => {
  it('is eligible in-scope, capping policy by effective risk', () => {
    const input: EligibilityInput = {
      lane: makeLane(),
      classifierLevel: 'green',
      riskPathMap: [],
      touchedPaths: ['docs/a.md'],
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('green');
      expect(r.mergePolicy).toBe('auto');
      expect(r.gateSet).toBe('gate1');
    }
  });

  it('escalates out-of-scope changes regardless of risk', () => {
    const input: EligibilityInput = {
      lane: makeLane(),
      classifierLevel: 'green',
      riskPathMap: [],
      touchedPaths: ['src/secret.ts'],
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('out-of-scope');
  });

  it('caps an auto lane to hold when a risk-path floor raises to orange', () => {
    const input: EligibilityInput = {
      lane: makeLane({ allowedPaths: ['**'], mergePolicy: 'auto' }),
      classifierLevel: 'green',
      riskPathMap: [{ paths: ['migrations/**'], minLevel: 'orange' }],
      touchedPaths: ['migrations/001.sql'],
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('orange');
      expect(r.mergePolicy).toBe('hold');
    }
  });
});
