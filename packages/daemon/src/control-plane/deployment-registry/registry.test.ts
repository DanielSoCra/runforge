// packages/daemon/src/control-plane/deployment-registry/registry.test.ts
//
// IMMOVABLE acceptance contract for the registry's register/lookup/resolve ops.
// All behavioral — these FAIL (red) at handoff because the registry bodies throw
// 'not implemented'. Kimi fills the bodies to make them pass; the tests may NOT
// be weakened.
import { describe, it, expect } from 'vitest';
import { DeploymentRegistry } from './registry.js';

/** A structurally valid raw profile, parameterized so tests can vary repo/id. */
function makeProfile(over: { repositories?: { owner: string; name: string }[] } = {}) {
  return {
    repositories: over.repositories ?? [{ owner: 'acme', name: 'auto-claude' }],
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
    honestAutomation: { automatable: ['docs'], strained: [], irreduciblyHuman: ['triage'] },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' } },
    capabilityBindings: [{ capability: 'classifier', version: '1.2.0' }],
  };
}

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

describe('DeploymentRegistry.register / lookup', () => {
  it('register with a valid profile → ok: true; lookup finds it by id', () => {
    const reg = new DeploymentRegistry();
    const out = reg.register('dep-a', makeProfile());
    expect(out.ok).toBe(true);

    const found = reg.lookup('dep-a');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') expect(found.profile.id).toBe('dep-a');
  });

  it('register with an invalid profile → ok: false with offenders; NOT stored (atomic)', () => {
    const reg = new DeploymentRegistry();
    const bad = { ...makeProfile(), typoKey: 'oops' };
    const out = reg.register('dep-a', bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.offenders.length).toBeGreaterThan(0);

    // No partial accept — the profile must not be stored.
    expect(reg.lookup('dep-a').kind).toBe('not-found');
  });

  it('cross-deployment repo ownership: B claiming A’s repo → ok: false naming the repo; A intact', () => {
    const reg = new DeploymentRegistry();
    expect(reg.register('dep-a', makeProfile({ repositories: [{ owner: 'acme', name: 'shared-repo' }] })).ok).toBe(true);

    const out = reg.register('dep-b', makeProfile({ repositories: [{ owner: 'acme', name: 'shared-repo' }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.offenders.join()).toContain('shared-repo');

    // A stays intact; B never became active.
    expect(reg.lookup('dep-a').kind).toBe('found');
    expect(reg.lookup('dep-b').kind).toBe('not-found');
  });

  it('lookup(unknownId) → tagged not-found, no throw', () => {
    const reg = new DeploymentRegistry();
    const r = reg.lookup('nope');
    expect(r.kind).toBe('not-found');
    if (r.kind === 'not-found') expect(r.deploymentId).toBe('nope');
  });
});

describe('DeploymentRegistry.resolveLaneEngineInputs', () => {
  it('returns exactly { laneSet, riskPathMap, defaultMinLevel, mode } from the profile', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());

    const r = reg.resolveLaneEngineInputs('dep-a');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(Object.keys(r.inputs).sort()).toEqual(
        ['defaultMinLevel', 'laneSet', 'mode', 'riskPathMap'],
      );
      expect(r.inputs.mode).toBe('velocity');
      expect(r.inputs.defaultMinLevel).toBe('green');
      expect(r.inputs.riskPathMap[0]!.minLevel).toBe('orange');
      expect(r.inputs.laneSet.mostCautiousLane).toBe('standard');
    }
  });

  it('resolveLaneEngineInputs(unknownId) → tagged not-found', () => {
    const reg = new DeploymentRegistry();
    expect(reg.resolveLaneEngineInputs('nope').kind).toBe('not-found');
  });
});

describe('DeploymentRegistry.resolveCapacityPoolInputs (fleet-level)', () => {
  it('returns the fleet pool set + preference order, set once in the constructor', () => {
    const reg = new DeploymentRegistry({ pools: validPools as never });
    const r = reg.resolveCapacityPoolInputs();
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.pools.map((p) => p.name)).toEqual(['sub-a', 'sub-b']);
      expect(r.pools.map((p) => p.preferenceRank)).toEqual([0, 1]);
    }
  });

  it('is fleet-level: same result regardless of any deployment id registered', () => {
    const reg = new DeploymentRegistry();
    const set = reg.setFleetCapacity(validPools);
    expect(set.ok).toBe(true);

    reg.register('dep-a', makeProfile());
    reg.register('dep-b', makeProfile({ repositories: [{ owner: 'acme', name: 'other' }] }));

    // No id argument — the capacity config is fleet-level, not deployment-scoped.
    const r = reg.resolveCapacityPoolInputs();
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.pools).toHaveLength(2);
  });
});
