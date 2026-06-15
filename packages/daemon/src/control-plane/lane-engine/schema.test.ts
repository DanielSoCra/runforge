// packages/daemon/src/control-plane/lane-engine/schema.test.ts
import { describe, it, expect } from 'vitest';
import { parseLaneSet } from './schema.js';

const valid = {
  declaredPhases: ['velocity', 'clinical'],
  mostCautiousLane: 'standard',
  lanes: [
    {
      name: 'trivial',
      qualify: { complexity: ['simple'], changeKind: ['docs'] },
      allowedPaths: ['docs/**', '**/*.md'],
      roleRouting: { implement: 'cheap-implementer', review: 'frontier-reviewer' },
      gateSet: 'gate1-deterministic-only',
      mergePolicy: 'auto',
      earnIn: { cleanMerges: 10, bounceFreeDays: 3 },
    },
    {
      name: 'standard',
      qualify: { complexity: ['standard', 'complex'] },
      allowedPaths: ['**'],
      roleRouting: { implement: 'cheap-implementer' },
      gateSet: { velocity: 'gate1-plus-review', clinical: 'full-ladder' },
      mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
    },
  ],
};

describe('parseLaneSet', () => {
  it('accepts a valid lane set and freezes it', () => {
    const r = parseLaneSet(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.laneSet)).toBe(true);
      expect(r.laneSet.lanes).toHaveLength(2);
    }
  });

  it('rejects an empty allowedPaths (would look like a tripwire storm)', () => {
    const bad = structuredClone(valid);
    bad.lanes[0]!.allowedPaths = [];
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
  });

  it('rejects mostCautiousLane that names no declared lane', () => {
    const bad = structuredClone(valid);
    bad.mostCautiousLane = 'nonexistent';
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('mostCautiousLane');
  });

  it('rejects a per-mode map referencing an undeclared phase', () => {
    const bad = structuredClone(valid);
    (bad.lanes[1]!.gateSet as Record<string, string>) = { velocity: 'x', staging: 'y' };
    (bad.lanes[1]!.mergePolicy as Record<string, string>) = { velocity: 'auto', staging: 'hold' };
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('staging');
  });

  it('rejects a lane where gateSet is per-mode but mergePolicy is not (coherence)', () => {
    const bad = structuredClone(valid);
    (bad.lanes[1]!.mergePolicy as unknown) = 'hold';
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('coherent');
  });

  it('rejects duplicate lane names (assignment/audit persist only the name)', () => {
    const bad = structuredClone(valid);
    bad.lanes[0]!.name = 'standard'; // collides with lanes[1]; mostCautiousLane still resolves
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('duplicate lane name');
  });

  it('rejects a per-mode lane that omits a declared phase (would silently apply a looser policy)', () => {
    const bad = structuredClone(valid);
    // declaredPhases is [velocity, clinical] but this lane only declares velocity
    (bad.lanes[1]!.gateSet as Record<string, string>) = { velocity: 'gate1-plus-review' };
    (bad.lanes[1]!.mergePolicy as Record<string, string>) = { velocity: 'review-then-auto' };
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("cover declared phase 'clinical'");
  });

  it('rejects overlapping lane qualifications (a catch-all makes a specific lane unreachable)', () => {
    const bad = structuredClone(valid);
    (bad.lanes[0]!.qualify as Record<string, string[]>) = {}; // catch-all — overlaps the 'standard' lane
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('overlapping qualifications');
  });

  it('deep-freezes the parsed lane set (nested arrays and lanes are immutable)', () => {
    const r = parseLaneSet(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.laneSet.lanes)).toBe(true);
      expect(Object.isFrozen(r.laneSet.lanes[0])).toBe(true);
      expect(Object.isFrozen(r.laneSet.lanes[0]!.allowedPaths)).toBe(true);
    }
  });
});
