// packages/daemon/src/control-plane/deployment-registry/autonomy.test.ts
//
// IMMOVABLE acceptance contract for the per-deployment, per-risk-class autonomy
// state — the one mutable slice. All behavioral → these FAIL (red) at handoff
// (registry bodies throw 'not implemented'). Kimi fills the bodies. The risk
// vocabulary is the lane engine's enum (RiskClass = RiskLevel); we assert
// behavior, not internal spellings.
import { describe, it, expect } from 'vitest';
import { DeploymentRegistry } from './registry.js';
import type { AutonomyAuthorization, RiskClass } from './types.js';

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
    landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
    capabilityBindings: [{ capability: 'classifier', version: '1.2.0' }],
  };
}

const auth: AutonomyAuthorization = { kind: 'operator-grant', operator: 'daniel' };
const NOW = 1_700_000_000_000;
const CLASSES: RiskClass[] = ['green', 'yellow', 'orange', 'red'];

function levelOf(reg: DeploymentRegistry, id: string, riskClass: RiskClass): string | undefined {
  return reg.readAutonomyState(id, riskClass).find((e) => e.riskClass === riskClass)?.level;
}

describe('autonomy — default state', () => {
  it('every risk class reads human-gated before any widening', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());
    for (const c of CLASSES) {
      expect(levelOf(reg, 'dep-a', c)).toBe('human-gated');
    }
  });
});

describe('autonomy — widening isolation', () => {
  it('widening one class on A reads widened; a different class on A and same class on B are untouched', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());
    reg.register('dep-b', makeProfile({ repositories: [{ owner: 'acme', name: 'other' }] }));

    const out = reg.recordWidening('dep-a', 'orange', 'widened', auth, NOW);
    expect(out.ok).toBe(true);

    expect(levelOf(reg, 'dep-a', 'orange')).toBe('widened');
    // A different class on A is untouched.
    expect(levelOf(reg, 'dep-a', 'red')).toBe('human-gated');
    // The same class on B is untouched (cross-deployment isolation).
    expect(levelOf(reg, 'dep-b', 'orange')).toBe('human-gated');
  });
});

describe('autonomy — widening record (append-only history)', () => {
  it('appends a record with prior state, new state, authorization and the passed-in timestamp', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());

    const out = reg.recordWidening('dep-a', 'yellow', 'widened', auth, NOW);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const record = out.state.history.at(-1)!;
      expect(record.deploymentId).toBe('dep-a');
      expect(record.riskClass).toBe('yellow');
      expect(record.prior).toBe('human-gated');
      expect(record.next).toBe('widened');
      expect(record.authorization).toEqual(auth);
      expect(record.recordedAt).toBe(NOW);
    }
  });
});

describe('autonomy — demotion is reconstructable history', () => {
  it('a demotion returns the class to human-gated and appends a record', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());

    reg.recordWidening('dep-a', 'orange', 'widened', auth, NOW);
    const demote = reg.recordWidening('dep-a', 'orange', 'human-gated', auth, NOW + 1000);
    expect(demote.ok).toBe(true);

    expect(levelOf(reg, 'dep-a', 'orange')).toBe('human-gated');
    if (demote.ok) {
      const history = demote.state.history.filter((h) => h.riskClass === 'orange');
      expect(history).toHaveLength(2);
      const last = history.at(-1)!;
      expect(last.prior).toBe('widened');
      expect(last.next).toBe('human-gated');
      expect(last.recordedAt).toBe(NOW + 1000);
    }
  });
});

describe('autonomy — rejected writes mutate nothing', () => {
  it('an unknown deployment is rejected and nothing is written', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());

    const out = reg.recordWidening('dep-unknown', 'orange', 'widened', auth, NOW);
    expect(out.ok).toBe(false);
    // A's state is untouched.
    expect(levelOf(reg, 'dep-a', 'orange')).toBe('human-gated');
  });

  it('an unauthorized widening (no operator) is rejected, state unchanged', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile());

    const noAuth = { kind: 'operator-grant', operator: '' } as AutonomyAuthorization;
    const out = reg.recordWidening('dep-a', 'orange', 'widened', noAuth, NOW);
    expect(out.ok).toBe(false);
    expect(levelOf(reg, 'dep-a', 'orange')).toBe('human-gated');
  });
});
