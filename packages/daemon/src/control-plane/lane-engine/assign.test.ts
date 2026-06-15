// packages/daemon/src/control-plane/lane-engine/assign.test.ts
import { describe, it, expect } from 'vitest';
import { assignLane } from './assign.js';
import type { ResolvedLane, ResolvedLaneSet } from './types.js';

function lane(name: string, qualify: ResolvedLane['qualify']): ResolvedLane {
  return {
    name,
    qualify,
    allowedPaths: ['**'],
    roleRouting: {},
    gateSet: 'full-ladder',
    mergePolicy: 'hold',
  };
}

const laneSet: ResolvedLaneSet = {
  lanes: [
    lane('trivial', { complexity: ['simple'], changeKind: ['docs'] }),
    lane('standard', { complexity: ['standard', 'complex'] }),
  ],
  mostCautiousLane: 'standard-hold',
  resolution: { mode: 'velocity', degraded: false },
};

describe('assignLane', () => {
  it('assigns the single lane whose qualification matches', () => {
    const r = assignLane(laneSet, { complexity: 'simple', changeKind: 'docs' });
    expect(r.kind).toBe('assigned');
    expect(r.lane).toBe('trivial');
  });

  it('falls back to most-cautious on no match', () => {
    const r = assignLane(laneSet, { complexity: 'simple', changeKind: 'feature' });
    expect(r).toEqual({ kind: 'fallback-most-cautious', lane: 'standard-hold', cause: 'no-match' });
  });

  it('falls back to most-cautious on ambiguous (2+) match', () => {
    const ambiguous: ResolvedLaneSet = {
      ...laneSet,
      lanes: [lane('a', { complexity: ['simple'] }), lane('b', { complexity: ['simple'] })],
    };
    const r = assignLane(ambiguous, { complexity: 'simple' });
    expect(r).toEqual({ kind: 'fallback-most-cautious', lane: 'standard-hold', cause: 'ambiguous' });
  });

  it('falls back to most-cautious when the verdict is unavailable', () => {
    const r = assignLane(laneSet, null);
    expect(r).toEqual({
      kind: 'fallback-most-cautious',
      lane: 'standard-hold',
      cause: 'verdict-unavailable',
    });
  });

  it('qualifies on declared scope', () => {
    const scoped: ResolvedLaneSet = {
      ...laneSet,
      lanes: [lane('frontend', { scope: ['frontend'] }), lane('backend', { scope: ['backend'] })],
    };
    expect(assignLane(scoped, { scope: 'frontend' })).toEqual({
      kind: 'assigned',
      lane: 'frontend',
      reasons: ['scope=frontend'],
    });
    const miss = assignLane(scoped, { scope: 'data' });
    expect(miss.kind).toBe('fallback-most-cautious');
    if (miss.kind === 'fallback-most-cautious') expect(miss.cause).toBe('no-match');
  });
});
