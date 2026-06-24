// GATE (immovable) — Phase B slice 2: durable autonomy state.
//
// The second autonomy dead-end: recordWidening had ZERO callers and autonomy lived only in an
// in-memory Map (lost on restart) — so decideMerge always escalated 'autonomy-not-widened'.
// This pins: an injectable AutonomyStore persists widenings, and a registry rebuilt from the same
// store (a simulated daemon restart) still reads the widening — so an Operator grant is durable
// and the integrate seam (which already queries readAutonomyState) sees it.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentRegistry, JsonFileAutonomyStore } from './registry.js';
import type { AutonomyAuthorization, RiskClass } from './types.js';

const auth: AutonomyAuthorization = { kind: 'operator-grant', operator: 'daniel' };
const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'autonomy-'));
  dirs.push(d);
  return join(d, 'autonomy.json');
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeProfile() {
  return {
    repositories: [{ owner: 'acme', name: 'auto-claude' }],
    riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity'],
      mostCautiousLane: 'standard',
      lanes: [
        { name: 'fast', qualify: { complexity: ['simple'] }, allowedPaths: ['**'], roleRouting: { implement: 'cheap-implementer' }, gateSet: 'gate1', mergePolicy: 'auto' },
        { name: 'standard', qualify: { complexity: ['standard', 'complex'] }, allowedPaths: ['**'], roleRouting: { implement: 'cheap-implementer' }, gateSet: 'gate1', mergePolicy: 'auto' },
      ],
    },
    lifecycleMode: 'velocity',
    complianceReviewers: [],
    honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
    capabilityBindings: [],
  };
}
const laneLevel = (reg: DeploymentRegistry, id: string, rc: RiskClass, lane: string): string | undefined =>
  reg.readAutonomyState(id, rc, lane).find((e) => e.riskClass === rc)?.level;

describe('autonomy persistence', () => {
  it('a recorded widening survives a registry rebuilt from the same store (simulated restart)', () => {
    const file = tmpFile();
    const reg1 = new DeploymentRegistry({ autonomyStore: new JsonFileAutonomyStore(file) });
    reg1.register('dep-a', makeProfile() as never);
    expect(reg1.recordWidening('dep-a', 'green', 'widened', auth, NOW, 'fast').ok).toBe(true);
    expect(laneLevel(reg1, 'dep-a', 'green', 'fast')).toBe('widened');

    // Simulated daemon restart: a brand-new registry + store reading the SAME file.
    const reg2 = new DeploymentRegistry({ autonomyStore: new JsonFileAutonomyStore(file) });
    reg2.register('dep-a', makeProfile() as never); // profiles aren't persisted; re-registering must NOT wipe loaded autonomy
    expect(laneLevel(reg2, 'dep-a', 'green', 'fast')).toBe('widened');
    // an un-widened class is still gated after restart
    expect(laneLevel(reg2, 'dep-a', 'red', 'fast')).toBe('human-gated');
  });

  it('a demotion persists too (re-gates after restart)', () => {
    const file = tmpFile();
    const reg1 = new DeploymentRegistry({ autonomyStore: new JsonFileAutonomyStore(file) });
    reg1.register('dep-a', makeProfile() as never);
    reg1.recordWidening('dep-a', 'green', 'widened', auth, NOW, 'fast');
    reg1.recordWidening('dep-a', 'green', 'human-gated', auth, NOW + 1, 'fast'); // demote
    const reg2 = new DeploymentRegistry({ autonomyStore: new JsonFileAutonomyStore(file) });
    reg2.register('dep-a', makeProfile() as never);
    expect(laneLevel(reg2, 'dep-a', 'green', 'fast')).toBe('human-gated');
  });

  it('no store ⇒ in-memory only (default behavior preserved; nothing persisted)', () => {
    const reg = new DeploymentRegistry();
    reg.register('dep-a', makeProfile() as never);
    expect(reg.recordWidening('dep-a', 'green', 'widened', auth, NOW, 'fast').ok).toBe(true);
    expect(laneLevel(reg, 'dep-a', 'green', 'fast')).toBe('widened');
  });
});
