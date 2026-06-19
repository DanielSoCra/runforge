// packages/daemon/src/control-plane/sanitization/build-pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { buildSanitizationPipeline } from './build-pipeline.js';
import type { DeploymentProfile } from '../deployment-registry/types.js';

const baseProfile: DeploymentProfile = {
  id: 'dep-a',
  repositories: [{ owner: 'acme', name: 'auto-claude' }],
  riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
  defaultMinLevel: 'green',
  laneSet: {
    declaredPhases: ['velocity'],
    mostCautiousLane: 'standard',
    lanes: [],
  } as unknown as DeploymentProfile['laneSet'],
  lifecycleMode: 'velocity',
  complianceReviewers: [],
  honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
  budget: 5000,
  landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
  capabilityBindings: [],
};

describe('buildSanitizationPipeline', () => {
  it('returns an empty/identity pipeline when no profile is supplied', () => {
    const pipeline = buildSanitizationPipeline(undefined);
    expect(pipeline.isEmpty).toBe(true);
  });

  it('returns an empty/identity pipeline when sanitizers is explicitly empty', () => {
    const pipeline = buildSanitizationPipeline({
      ...baseProfile,
      sanitizers: [],
    });
    expect(pipeline.isEmpty).toBe(true);
  });
});
