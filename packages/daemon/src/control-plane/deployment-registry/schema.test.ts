// packages/daemon/src/control-plane/deployment-registry/schema.test.ts
//
// IMMOVABLE acceptance contract for the envelope schemas + parsers. The
// declarative `.strict()`/rejection cases exercise REAL zod + the composed
// parseLaneSet / validatePoolMembership and PASS at handoff; the success-path
// cases (valid → frozen) FAIL (red) until the implementer fills the stubbed
// assemble/freeze step. That mixed red/green is the correct handoff state.
import { describe, it, expect } from 'vitest';
import { parseProfile, parseFleetCapacity } from './schema.js';

/** A structurally valid raw deployment profile (envelope + a valid lane set). */
const validProfile = {
  repositories: [{ owner: 'acme', name: 'auto-claude' }],
  riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
  defaultMinLevel: 'green',
  laneSet: {
    declaredPhases: ['velocity', 'clinical'],
    mostCautiousLane: 'standard',
    lanes: [
      {
        name: 'trivial',
        qualify: { complexity: ['simple'], changeKind: ['docs'] },
        allowedPaths: ['docs/**'],
        roleRouting: { implement: 'cheap-implementer' },
        gateSet: 'gate1',
        mergePolicy: 'auto',
      },
      {
        name: 'standard',
        qualify: { complexity: ['standard', 'complex'] },
        allowedPaths: ['**'],
        roleRouting: { implement: 'cheap-implementer' },
        gateSet: { velocity: 'gate1-plus', clinical: 'full' },
        mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
      },
    ],
  },
  lifecycleMode: 'velocity',
  complianceReviewers: [{ reviewer: 'clinical-lead', condition: 'touches patient-data' }],
  honestAutomation: { automatable: ['docs'], strained: ['migrations'], irreduciblyHuman: ['triage'] },
  budget: 5000,
  landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
  capabilityBindings: [{ capability: 'classifier', version: '1.2.0' }],
};

describe('parseProfile — success path (deep-frozen profile)', () => {
  it('a valid DeploymentProfile parses → ok: true and returns a profile', () => {
    const r = parseProfile('dep-a', validProfile);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.id).toBe('dep-a');
  });

  it('the returned profile is deep-frozen at top and nested levels', () => {
    const r = parseProfile('dep-a', validProfile);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.profile)).toBe(true);
      expect(Object.isFrozen(r.profile.repositories)).toBe(true);
      expect(Object.isFrozen(r.profile.repositories[0])).toBe(true);
      expect(Object.isFrozen(r.profile.riskPathMap)).toBe(true);
      expect(Object.isFrozen(r.profile.laneSet)).toBe(true);
      expect(Object.isFrozen(r.profile.laneSet.lanes)).toBe(true);
    }
  });

  it('a write to the frozen profile does not mutate it', () => {
    const r = parseProfile('dep-a', validProfile);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const before = r.profile.budget;
      try {
        (r.profile as { budget: number }).budget = 999_999;
      } catch {
        // strict-mode write throws — acceptable
      }
      expect(r.profile.budget).toBe(before);
    }
  });
});

describe('parseProfile — fail-closed rejections (real zod / composed parsers)', () => {
  it('.strict() rejects an unknown top-level key, offenders names it', () => {
    const r = parseProfile('dep-a', { ...validProfile, deploymentName: 'oops' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('deploymentName');
  });

  it('a malformed lane set (duplicate lane name) rejects the whole profile', () => {
    const bad = structuredClone(validProfile);
    bad.laneSet.lanes[0]!.name = 'standard'; // duplicates lanes[1]
    const r = parseProfile('dep-a', bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('duplicate lane name');
  });

  it('a risk-path entry naming an unknown risk level is rejected', () => {
    const bad = structuredClone(validProfile);
    (bad.riskPathMap[0] as { minLevel: string }).minLevel = 'magenta';
    const r = parseProfile('dep-a', bad);
    expect(r.ok).toBe(false);
  });

  it('a missing defaultMinLevel is rejected (no floor cannot fail safe)', () => {
    const bad = structuredClone(validProfile) as Record<string, unknown>;
    delete bad.defaultMinLevel;
    const r = parseProfile('dep-a', bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('defaultMinLevel');
  });

  it('a lifecycle mode not among the lane set declared phases is rejected', () => {
    const bad = structuredClone(validProfile);
    bad.lifecycleMode = 'staging'; // declaredPhases is [velocity, clinical]
    const r = parseProfile('dep-a', bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('lifecycleMode');
  });

  it('sanitizers is optional; omitted ⇒ profile.sanitizers is undefined', () => {
    const r = parseProfile('dep-a', validProfile);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.sanitizers).toBeUndefined();
  });

  it('sanitizers parses with a withholding binding', () => {
    const withSanitizers = structuredClone(validProfile) as Record<string, unknown>;
    withSanitizers.sanitizers = [{ plugin: 'withholding' }];
    const r = parseProfile('dep-a', withSanitizers);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.sanitizers).toEqual([{ plugin: 'withholding' }]);
    }
  });
});

// --- Fleet capacity ---------------------------------------------------------

const validPools = [
  {
    name: 'sub-a',
    providers: ['p1', 'p2'],
    window: { lengthMs: 18_000_000, reset: 'rolling-from-first-use' },
    signalSources: ['retry-after'],
    preferenceRank: 0,
  },
  {
    name: 'sub-b',
    providers: ['p3'],
    window: { lengthMs: 18_000_000, reset: 'fixed-schedule' },
    signalSources: ['reported-quota'],
    preferenceRank: 1,
  },
];

describe('parseFleetCapacity', () => {
  it('a valid FleetCapacityConfig parses → ok: true (frozen)', () => {
    const r = parseFleetCapacity(validPools);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.fleet)).toBe(true);
      expect(r.fleet.pools).toHaveLength(2);
    }
  });

  it('a provider claimed by two pools is rejected (validatePoolMembership)', () => {
    const bad = structuredClone(validPools);
    bad[1]!.providers = ['p3', 'p1']; // p1 now in two pools
    const r = parseFleetCapacity(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders).toContain('p1');
  });
});
