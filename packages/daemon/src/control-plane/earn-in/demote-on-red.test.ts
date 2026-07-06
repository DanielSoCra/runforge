import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRedEvent, triggerDemoteOnRed } from './demote-on-red.js';
import { DeploymentRegistry, JsonFileAutonomyStore } from '../deployment-registry/registry.js';
import { laneOutcomesPath, loadLaneOutcomes } from '../lane-engine/outcome-ledger.js';

const NOW = Date.UTC(2026, 6, 3);

function makeProfile() {
  return {
    repositories: [{ owner: 'acme', name: 'auto-claude' }],
    riskPathMap: [{ paths: ['**'], minLevel: 'green' }],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity'],
      mostCautiousLane: 'trivial',
      lanes: [
        {
          name: 'trivial',
          qualify: { complexity: ['simple'] },
          allowedPaths: ['**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: 'gate1',
          mergePolicy: 'auto',
        },
      ],
    },
    lifecycleMode: 'velocity',
    complianceReviewers: [],
    honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: { kind: 'platform-performs' } },
    capabilityBindings: [],
  };
}

describe('isRedEvent', () => {
  it('is false for healthy and true for red/indeterminate', () => {
    expect(isRedEvent('healthy')).toBe(false);
    expect(isRedEvent('red')).toBe(true);
    expect(isRedEvent('indeterminate')).toBe(true);
  });
});

describe('triggerDemoteOnRed', () => {
  const dirs: string[] = [];
  const tmpDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'p4-earnin-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
  });

  it('appends a red outcome and demotes level-wide', async () => {
    const stateDir = tmpDir();
    const store = new JsonFileAutonomyStore(join(stateDir, 'autonomy.json'));
    const reg = new DeploymentRegistry({ autonomyStore: store });
    reg.register('dep-a', makeProfile());

    const grant = reg.recordWidening('dep-a', 'green', 'widened', { kind: 'operator-grant', operator: 'daniel' }, NOW, 'trivial');
    expect(grant.ok).toBe(true);
    expect(reg.readAutonomyState('dep-a', 'green', 'trivial')[0]?.level).toBe('widened');

    await triggerDemoteOnRed({
      registry: reg,
      stateDir,
      deploymentId: 'dep-a',
      lane: 'trivial',
      riskClass: 'green',
      redReason: 'failed-release',
      now: NOW + 1000,
    });

    expect(reg.readAutonomyState('dep-a', 'green', 'trivial')[0]?.level).toBe('human-gated');
    const outcomes = await loadLaneOutcomes(laneOutcomesPath(stateDir));
    expect(outcomes.some((o) => o.kind === 'red' && o.redReason === 'failed-release')).toBe(true);

    const history = reg.readAutonomyHistory('dep-a');
    expect(history.some((h) => h.next === 'human-gated' && h.lane === undefined && (h.authorization as { kind: string }).kind === 'demote-on-red')).toBe(true);
  });
});
