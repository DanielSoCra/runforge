// variant.test.ts
import { describe, it, expect } from 'vitest';
import { specDrivenPhases, specDrivenTransitions, isSpecDrivenRequest, getPhaseDefinition } from './variant.js';
import { transition } from '../fsm.js';
import type { WorkRequest } from '../../types.js';

describe('specDrivenPhases', () => {
  it('has 10 phases in correct order', () => {
    expect(specDrivenPhases).toHaveLength(10);
    expect(specDrivenPhases.map(p => p.name)).toEqual([
      'detect', 'l2-design', 'l2-gate', 'l3-generate', 'l3-compliance',
      'implement', 'review', 'holdout', 'integrate', 'report',
    ]);
  });

  it('l2-gate is a gate type', () => {
    const gate = specDrivenPhases.find(p => p.name === 'l2-gate');
    expect(gate?.type).toBe('gate');
  });

  it('l2-design is a session type with l2-designer', () => {
    const phase = specDrivenPhases.find(p => p.name === 'l2-design');
    expect(phase?.type).toBe('session');
    expect(phase?.sessionType).toBe('l2-designer');
  });

  it('implement is delegated', () => {
    const phase = specDrivenPhases.find(p => p.name === 'implement');
    expect(phase?.type).toBe('delegated');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(specDrivenPhases)).toBe(true);
  });
});

describe('specDrivenTransitions', () => {
  const table = specDrivenTransitions;

  it('detect → success → l2-design', () => {
    expect(transition(table, 'detect', 'success')?.next).toBe('l2-design');
  });

  it('detect → failure → stuck', () => {
    expect(transition(table, 'detect', 'failure')?.next).toBe('stuck');
  });

  it('l2-design → success → l2-gate', () => {
    expect(transition(table, 'l2-design', 'success')?.next).toBe('l2-gate');
  });

  it('l2-design → failure → l2-design (retry)', () => {
    expect(transition(table, 'l2-design', 'failure')?.next).toBe('l2-design');
  });

  it('l2-gate → success → l3-generate', () => {
    expect(transition(table, 'l2-gate', 'success')?.next).toBe('l3-generate');
  });

  it('l2-gate → feedback → l2-design', () => {
    expect(transition(table, 'l2-gate', 'feedback')?.next).toBe('l2-design');
  });

  it('l2-gate has no unchanged transition (removed — parking handled by pausedAtPhase)', () => {
    expect(transition(table, 'l2-gate', 'unchanged')).toBeUndefined();
  });

  it('l3-generate → success → l3-compliance', () => {
    expect(transition(table, 'l3-generate', 'success')?.next).toBe('l3-compliance');
  });

  it('l3-compliance → failure → l3-generate (retry)', () => {
    expect(transition(table, 'l3-compliance', 'failure')?.next).toBe('l3-generate');
  });

  it('l3-compliance → success → implement', () => {
    expect(transition(table, 'l3-compliance', 'success')?.next).toBe('implement');
  });

  it('l3-compliance → escalated → stuck', () => {
    expect(transition(table, 'l3-compliance', 'escalated')?.next).toBe('stuck');
  });

  it('implement → success → review', () => {
    expect(transition(table, 'implement', 'success')?.next).toBe('review');
  });

  it('review → success → holdout', () => {
    expect(transition(table, 'review', 'success')?.next).toBe('holdout');
  });

  it('holdout → success → integrate', () => {
    expect(transition(table, 'holdout', 'success')?.next).toBe('integrate');
  });

  // Regression for #449: holdout Type A failure (fix cycles remain) must route back to implement,
  // not stuck. phases.ts:745 returns 'failure' expecting a retry via the implement phase.
  it('holdout → failure → implement (Type A fix cycle retry, regression #449)', () => {
    expect(transition(table, 'holdout', 'failure')?.next).toBe('implement');
  });

  // Regression for #448: holdout handler returns 'escalated' in multiple paths
  // (Type B/C diagnosis, max-fix-cycles exceeded, diagnosis session failure).
  // Without this transition, advancePhase() returned false and pipeline.ts silently
  // forced run.phase = 'stuck' with an opaque "No transition for holdout:escalated" error.
  it('holdout → escalated → stuck (regression #448)', () => {
    expect(transition(table, 'holdout', 'escalated')?.next).toBe('stuck');
  });

  it('report → failure → stuck', () => {
    expect(transition(table, 'report', 'failure')?.next).toBe('stuck');
  });
});

describe('isSpecDrivenRequest', () => {
  const baseRequest: WorkRequest = {
    issueNumber: 200,
    title: 'Test',
    body: 'See: `.specify/functional/pipeline-orchestration.md`',
    labels: ['feature-pipeline', 'l1-approved'],
    specRefs: ['FUNC-AC-PIPELINE'],
  };

  it('returns true for feature-pipeline with spec refs', () => {
    expect(isSpecDrivenRequest(baseRequest)).toBe(true);
  });

  it('returns false without feature-pipeline label', () => {
    const req = { ...baseRequest, labels: ['bug'] };
    expect(isSpecDrivenRequest(req)).toBe(false);
  });

  it('returns true when body has .specify/ path but no specRefs', () => {
    const req = { ...baseRequest, specRefs: [] };
    expect(isSpecDrivenRequest(req)).toBe(true);
  });

  it('returns true when body has spec ID pattern', () => {
    const req = { ...baseRequest, specRefs: [], body: 'Implements FUNC-AC-PIPELINE' };
    expect(isSpecDrivenRequest(req)).toBe(true);
  });

  it('returns false when feature-pipeline but no spec reference', () => {
    const req = { ...baseRequest, specRefs: [], body: 'Just a feature idea' };
    expect(isSpecDrivenRequest(req)).toBe(false);
  });
});

describe('getPhaseDefinition', () => {
  it('returns definition for l2-gate', () => {
    const def = getPhaseDefinition('l2-gate');
    expect(def?.type).toBe('gate');
    expect(def?.name).toBe('l2-gate');
  });

  it('returns undefined for unknown phase', () => {
    expect(getPhaseDefinition('stuck')).toBeUndefined();
  });
});
