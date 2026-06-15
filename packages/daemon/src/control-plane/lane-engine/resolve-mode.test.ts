// packages/daemon/src/control-plane/lane-engine/resolve-mode.test.ts
import { describe, it, expect } from 'vitest';
import { resolveForMode } from './resolve-mode.js';
import type { LaneSet } from './types.js';

const laneSet: LaneSet = {
  declaredPhases: ['velocity', 'clinical'],
  mostCautiousLane: 'standard',
  lanes: [
    {
      name: 'trivial',
      qualify: { complexity: ['simple'] },
      allowedPaths: ['docs/**'],
      roleRouting: {},
      gateSet: 'gate1',
      mergePolicy: 'auto',
    },
    {
      name: 'standard',
      qualify: { complexity: ['standard'] },
      allowedPaths: ['**'],
      roleRouting: {},
      gateSet: { velocity: 'gate1-plus-review', clinical: 'full-ladder' },
      mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
    },
  ],
};

describe('resolveForMode', () => {
  it('resolves per-mode maps to the named phase', () => {
    const r = resolveForMode(laneSet, 'velocity');
    expect(r.resolution).toEqual({ mode: 'velocity', degraded: false, cause: undefined });
    const standard = r.lanes.find((l) => l.name === 'standard')!;
    expect(standard.gateSet).toBe('gate1-plus-review');
    expect(standard.mergePolicy).toBe('review-then-auto');
  });

  it('leaves plain fields untouched', () => {
    const trivial = resolveForMode(laneSet, 'clinical').lanes.find((l) => l.name === 'trivial')!;
    expect(trivial.gateSet).toBe('gate1');
    expect(trivial.mergePolicy).toBe('auto');
  });

  it('degrades to the most cautious phase when the mode is null', () => {
    const r = resolveForMode(laneSet, null);
    expect(r.resolution.degraded).toBe(true);
    const standard = r.lanes.find((l) => l.name === 'standard')!;
    // most cautious mergePolicy among {review-then-auto, hold} is hold (clinical)
    expect(standard.mergePolicy).toBe('hold');
    expect(standard.gateSet).toBe('full-ladder');
  });

  it('degrades when the mode is not a declared phase', () => {
    const r = resolveForMode(laneSet, 'staging');
    expect(r.resolution).toEqual({ mode: null, degraded: true, cause: 'mode-undeclared:staging' });
    expect(r.lanes.find((l) => l.name === 'standard')!.mergePolicy).toBe('hold');
  });
});
