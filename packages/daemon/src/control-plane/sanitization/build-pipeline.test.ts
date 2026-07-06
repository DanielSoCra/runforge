// packages/daemon/src/control-plane/sanitization/build-pipeline.test.ts
//
// GATE (immovable) for 5a backend activation. Pins:
//  - identity default preserved (no profile / empty bindings ⇒ isEmpty).
//  - a configured "withholding" binding ACTIVATES when a ProtectedStore is supplied
//    (the pipeline is non-empty and withholds the configured field, keyed by subjectRef).
//  - fail-closed: a profile that activates "withholding" WITHOUT a store throws at build
//    (a misconfigured deployment must never silently pass sensitive content through).
//  - an unknown sanitizer name throws.
import { describe, it, expect } from 'vitest';
import type { PutArgs, ProtectedStore } from '@runforge/sanitizer-redaction';
import { buildSanitizationPipeline } from './build-pipeline.js';
import type { DeploymentProfile } from '../deployment-registry/types.js';

const baseProfile: DeploymentProfile = {
  id: 'dep-a',
  repositories: [{ owner: 'acme', name: 'runforge' }],
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
  landing: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' } },
  capabilityBindings: [],
};

function fakeStore(): { store: ProtectedStore; puts: PutArgs[] } {
  const puts: PutArgs[] = [];
  const store = {
    put(args: PutArgs): string {
      puts.push(args);
      return `protected://fake-${puts.length}`;
    },
    findRefForField(decision_id: string, field: string): string | undefined {
      for (let i = puts.length - 1; i >= 0; i--) {
        if (puts[i]!.decision_id === decision_id && puts[i]!.field === field) {
          return `protected://fake-${i + 1}`;
        }
      }
      return undefined;
    },
    get: (ref: string) => puts[Number(ref.split('-')[1]) - 1]!.plaintext,
    responseHmac: (c: string) => `hmac:${c.length}`,
    verifyIntegrity: () => true as const,
  };
  return { store: store as unknown as ProtectedStore, puts };
}

const withholdingProfile = (fields: string[]): DeploymentProfile => ({
  ...baseProfile,
  sanitizers: [{ plugin: 'withholding', options: { fields } }],
});

describe('buildSanitizationPipeline', () => {
  it('returns an identity pipeline when no profile is supplied', () => {
    expect(buildSanitizationPipeline(undefined).isEmpty).toBe(true);
  });

  it('returns an identity pipeline when sanitizers is explicitly empty', () => {
    expect(buildSanitizationPipeline({ ...baseProfile, sanitizers: [] }).isEmpty).toBe(true);
  });

  it('activates the withholding sanitizer when a ProtectedStore is supplied', async () => {
    const { store, puts } = fakeStore();
    const pipeline = buildSanitizationPipeline(withholdingProfile(['context']), {
      protectedStore: store,
    });
    expect(pipeline.isEmpty).toBe(false);

    const result = await pipeline.run({ content: { context: 'SENSITIVE' }, subjectRef: 'D-1' });
    // stored value is the protected:// ref (read-model contract), recoverable via the store.
    expect(result.content.context as string).toMatch(/^protected:\/\//);
    expect(result.withholdings).toHaveLength(1);
    expect(puts[0]!.decision_id).toBe('D-1');
    expect(JSON.parse(puts[0]!.plaintext)).toBe('SENSITIVE');
  });

  it('fails closed when a profile activates withholding without a store', () => {
    expect(() => buildSanitizationPipeline(withholdingProfile(['context']))).toThrow();
    expect(() =>
      buildSanitizationPipeline(withholdingProfile(['context']), { protectedStore: undefined }),
    ).toThrow();
  });

  it('throws on an unknown sanitizer name', () => {
    const profile: DeploymentProfile = {
      ...baseProfile,
      sanitizers: [{ plugin: 'does-not-exist', options: {} }],
    };
    expect(() => buildSanitizationPipeline(profile, { protectedStore: fakeStore().store })).toThrow();
  });
});
