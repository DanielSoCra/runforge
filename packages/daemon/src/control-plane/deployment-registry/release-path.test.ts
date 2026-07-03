import { describe, it, expect } from 'vitest';
import { ProfileEnvelopeSchema } from './schema.js';

const base = {
  repositories: [{ owner: 'acme', name: 'widgets' }],
  riskPathMap: [{ paths: ['src/'], minLevel: 'green' }],
  defaultMinLevel: 'green',
  laneSet: {},
  lifecycleMode: 'governed',
  complianceReviewers: [],
  honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
  budget: 100,
  capabilityBindings: [],
};
const withPath = (p: unknown) => ({ ...base, landing: { landsOn: 'main', productionReleasePath: p } });

describe('landing.productionReleasePath — discriminated 3-shape union', () => {
  it('accepts platform-performs', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'platform-performs' })).success).toBe(true);
  });
  it('accepts trigger-automated with a trigger', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'trigger-automated', trigger: 'deploy.yml' })).success).toBe(true);
  });
  it('accepts record-only with a procedure', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'record-only', procedure: 'runbook#release' })).success).toBe(true);
  });
  it('REJECTS a bare string (the old inert shape)', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath('tag-and-deploy')).success).toBe(false);
  });
  it('REJECTS trigger-automated without a trigger', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'trigger-automated' })).success).toBe(false);
  });
  it('REJECTS record-only without a procedure', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'record-only' })).success).toBe(false);
  });
  it('REJECTS an unknown kind', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'yolo' })).success).toBe(false);
  });
  it('REJECTS extra keys on platform-performs (strict)', () => {
    expect(ProfileEnvelopeSchema.safeParse(withPath({ kind: 'platform-performs', extra: 1 })).success).toBe(false);
  });
});
