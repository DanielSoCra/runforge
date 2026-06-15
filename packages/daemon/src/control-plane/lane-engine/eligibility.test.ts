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
      defaultMinLevel: 'green',
      touchedPaths: ['docs/a.md'],
      modeResolution: { mode: 'velocity', degraded: false },
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('green');
      expect(r.mergePolicy).toBe('auto');
      expect(r.gateSet).toBe('gate1');
    }
    expect(r.modeResolution).toEqual({ mode: 'velocity', degraded: false });
  });

  it('escalates out-of-scope changes regardless of risk', () => {
    const input: EligibilityInput = {
      lane: makeLane(),
      classifierLevel: 'green',
      riskPathMap: [],
      defaultMinLevel: 'green',
      touchedPaths: ['src/secret.ts'],
      modeResolution: { mode: 'velocity', degraded: false },
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('out-of-scope');
  });

  it('preserves a degraded mode resolution in the eligibility result (audit)', () => {
    const input: EligibilityInput = {
      lane: makeLane(),
      classifierLevel: 'green',
      riskPathMap: [],
      defaultMinLevel: 'green',
      touchedPaths: ['docs/a.md'],
      modeResolution: { mode: null, degraded: true, cause: 'mode-unreadable' },
    };
    const r = evaluateMergeEligibility(input);
    expect(r.modeResolution).toEqual({ mode: null, degraded: true, cause: 'mode-unreadable' });
  });

  it('caps an auto lane to hold when a risk-path floor raises to orange', () => {
    const input: EligibilityInput = {
      lane: makeLane({ allowedPaths: ['**'], mergePolicy: 'auto' }),
      classifierLevel: 'green',
      riskPathMap: [{ paths: ['migrations/**'], minLevel: 'orange' }],
      defaultMinLevel: 'green',
      touchedPaths: ['migrations/001.sql'],
      modeResolution: { mode: 'velocity', degraded: false },
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('orange');
      expect(r.mergePolicy).toBe('hold');
    }
  });

  it('applies the configured default minimum to an unmatched path (caps policy)', () => {
    const input: EligibilityInput = {
      lane: makeLane({ allowedPaths: ['**'], mergePolicy: 'auto' }),
      classifierLevel: 'green',
      riskPathMap: [],
      defaultMinLevel: 'yellow',
      touchedPaths: ['anything.ts'],
      modeResolution: { mode: 'velocity', degraded: false },
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('yellow'); // unmatched path raised to default minimum
      expect(r.mergePolicy).toBe('review-then-auto'); // auto capped by yellow
    }
  });
});
