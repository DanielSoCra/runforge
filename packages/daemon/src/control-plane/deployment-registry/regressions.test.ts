// packages/daemon/src/control-plane/deployment-registry/regressions.test.ts
// Regression tests for adversarial-review findings (codex GPT-5.5, 2026-06-17).
// These ADD coverage the acceptance gate did not pin; the gate files are immovable.
import { describe, it, expect } from 'vitest';
import { DeploymentRegistry } from './registry.js';
import type { AutonomyAuthorization } from './types.js';

const validPool = (name: string, providers: string[], preferenceRank: number) => ({
  name,
  providers,
  window: { lengthMs: 18_000_000, reset: 'rolling-from-first-use' },
  signalSources: ['retry-after'],
  preferenceRank,
});

describe('constructor validates fleet capacity (P2)', () => {
  it('a valid fleet config passed to the constructor is served', () => {
    const reg = new DeploymentRegistry({
      pools: [validPool('sub-a', ['p1'], 0), validPool('sub-b', ['p2'], 1)] as never,
    });
    const r = reg.resolveCapacityPoolInputs();
    expect(r.kind).toBe('found');
  });

  it('a constructor seed that violates one-provider-one-pool throws (no fail-open)', () => {
    // 'shared' is claimed by two pools — the cross-pool invariant the type cannot encode.
    expect(
      () =>
        new DeploymentRegistry({
          pools: [validPool('sub-a', ['shared'], 0), validPool('sub-b', ['shared'], 1)] as never,
        }),
    ).toThrow();
  });
});

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

const auth: AutonomyAuthorization = { kind: 'operator-grant', operator: 'daniel' };

describe('recordWidening returns immutable state (P2)', () => {
  it('the returned autonomy state is deep-frozen and cannot corrupt the registry', () => {
    const reg = new DeploymentRegistry();
    expect(reg.register('dep-a', makeProfile()).ok).toBe(true);

    const out = reg.recordWidening('dep-a', 'orange', 'widened', auth, 1_700_000_000_000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(Object.isFrozen(out.state)).toBe(true);
    expect(Object.isFrozen(out.state.entries)).toBe(true);
    expect(Object.isFrozen(out.state.history)).toBe(true);
    // Mutating the returned handle must not silently corrupt internal state.
    expect(() => out.state.history.push({} as never)).toThrow();

    // A later authorized read still reflects only the authorized widening.
    const reading = reg.readAutonomyState('dep-a', 'orange').find((e) => e.riskClass === 'orange');
    expect(reading?.level).toBe('widened');
  });
});
