import { describe, it, expect } from 'vitest';
import { routeDiagnosis } from './router.js';
import type { BugDiagnosis } from '../types.js';

function makeDiagnosis(overrides: Partial<BugDiagnosis> = {}): BugDiagnosis {
  return {
    type: 'A',
    confidence: 0.85,
    affectedSpecs: ['STACK-AC-DIAGNOSIS'],
    affectedArtifacts: [],
    suggestedAction: 'Fix it',
    reasoning: 'It is broken',
    ...overrides,
  };
}

describe('routeDiagnosis', () => {
  it('routes Type A above threshold to bug-pipeline', () => {
    const diagnosis = makeDiagnosis({ type: 'A', confidence: 0.8 });
    const decision = routeDiagnosis(diagnosis);
    expect(decision.route).toBe('bug-pipeline');
    expect(decision.diagnosis).toBe(diagnosis);
  });

  it('routes Type B above threshold to needs-spec-update', () => {
    const diagnosis = makeDiagnosis({ type: 'B', confidence: 0.8 });
    const decision = routeDiagnosis(diagnosis);
    expect(decision.route).toBe('needs-spec-update');
    expect(decision.diagnosis).toBe(diagnosis);
  });

  it('routes Type C above threshold to needs-human with reason', () => {
    const diagnosis = makeDiagnosis({ type: 'C', confidence: 0.8 });
    const decision = routeDiagnosis(diagnosis);
    expect(decision.route).toBe('needs-human');
    expect(decision.diagnosis).toBe(diagnosis);
    if (decision.route === 'needs-human') {
      expect(decision.reason).toBe('Type C: expectation mismatch');
    }
  });

  it('routes low confidence (below default threshold) to needs-human regardless of type A', () => {
    const diagnosis = makeDiagnosis({ type: 'A', confidence: 0.5 });
    const decision = routeDiagnosis(diagnosis);
    expect(decision.route).toBe('needs-human');
    if (decision.route === 'needs-human') {
      expect(decision.reason).toContain('Low confidence');
      expect(decision.reason).toContain('0.5');
    }
  });

  it('routes low confidence to needs-human regardless of type B', () => {
    const diagnosis = makeDiagnosis({ type: 'B', confidence: 0.3 });
    const decision = routeDiagnosis(diagnosis);
    expect(decision.route).toBe('needs-human');
    if (decision.route === 'needs-human') {
      expect(decision.reason).toContain('Low confidence');
    }
  });

  it('routes low confidence to needs-human regardless of type C', () => {
    const diagnosis = makeDiagnosis({ type: 'C', confidence: 0.1 });
    const decision = routeDiagnosis(diagnosis);
    expect(decision.route).toBe('needs-human');
    if (decision.route === 'needs-human') {
      expect(decision.reason).toContain('Low confidence');
    }
  });

  it('uses custom confidence threshold', () => {
    const diagnosis = makeDiagnosis({ type: 'A', confidence: 0.5 });
    const decision = routeDiagnosis(diagnosis, 0.4);
    expect(decision.route).toBe('bug-pipeline');
  });

  it('treats confidence exactly at threshold as passing', () => {
    const diagnosis = makeDiagnosis({ type: 'A', confidence: 0.7 });
    const decision = routeDiagnosis(diagnosis, 0.7);
    expect(decision.route).toBe('bug-pipeline');
  });

  it('treats confidence just below threshold as low confidence', () => {
    const diagnosis = makeDiagnosis({ type: 'A', confidence: 0.699 });
    const decision = routeDiagnosis(diagnosis, 0.7);
    expect(decision.route).toBe('needs-human');
  });

  it('returns a pure decision without side effects', () => {
    const diagnosis = makeDiagnosis({ type: 'A', confidence: 0.9 });
    const decision1 = routeDiagnosis(diagnosis);
    const decision2 = routeDiagnosis(diagnosis);
    expect(decision1).toEqual(decision2);
    expect(decision1.diagnosis).toBe(decision2.diagnosis);
  });
});
