// spec-chain.test.ts
import { describe, it, expect } from 'vitest';
import { validateChainForPhase, getSpecByLayer, appendSpec, type SpecChain, type SpecReference } from './spec-chain.js';

const l1Ref: SpecReference = { layer: 'l1', specId: 'FUNC-AC-PIPELINE', filePath: '.specify/functional/pipeline-orchestration.md', branch: 'dev' };
const l2Ref: SpecReference = { layer: 'l2', specId: 'ARCH-AC-SPEC-PIPELINE', filePath: '.specify/architecture/spec-pipeline.md', branch: 'spec/l2/200-spec-pipeline' };
const l3Ref: SpecReference = { layer: 'l3', specId: 'STACK-AC-SPEC-PIPELINE', filePath: '.specify/stack/spec-pipeline-ts.md', branch: 'spec/l3/200-spec-pipeline' };

describe('validateChainForPhase', () => {
  it('l2-design requires L1', () => {
    expect(validateChainForPhase([l1Ref], 'l2-design')).toBe(true);
  });

  it('l2-design fails without L1', () => {
    expect(validateChainForPhase([], 'l2-design')).toBe(false);
  });

  it('l3-generate requires L1 + L2', () => {
    expect(validateChainForPhase([l1Ref, l2Ref], 'l3-generate')).toBe(true);
  });

  it('l3-generate fails with only L1', () => {
    expect(validateChainForPhase([l1Ref], 'l3-generate')).toBe(false);
  });

  it('implement requires L1 + L2 + L3', () => {
    expect(validateChainForPhase([l1Ref, l2Ref, l3Ref], 'implement')).toBe(true);
  });

  it('implement fails with only L1 + L2', () => {
    expect(validateChainForPhase([l1Ref, l2Ref], 'implement')).toBe(false);
  });

  it('l3-compliance requires L1 + L2 + L3', () => {
    expect(validateChainForPhase([l1Ref, l2Ref, l3Ref], 'l3-compliance')).toBe(true);
  });

  it('detect has no requirements', () => {
    expect(validateChainForPhase([], 'detect')).toBe(true);
  });

  it('rejects malformed chain entries', () => {
    const bad = [{ layer: 'l1', specId: '', filePath: 'x', branch: 'y' }] as SpecChain;
    expect(validateChainForPhase(bad, 'l2-design')).toBe(false);
  });
});

describe('getSpecByLayer', () => {
  const chain: SpecChain = [l1Ref, l2Ref, l3Ref];

  it('returns the L1 spec', () => {
    expect(getSpecByLayer(chain, 'l1')).toEqual(l1Ref);
  });

  it('returns undefined for missing layer', () => {
    expect(getSpecByLayer([l1Ref], 'l3')).toBeUndefined();
  });
});

describe('appendSpec', () => {
  it('returns a new array with the appended spec', () => {
    const chain: SpecChain = [l1Ref];
    const result = appendSpec(chain, l2Ref);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(l2Ref);
  });

  it('does not mutate the original chain', () => {
    const chain: SpecChain = [l1Ref];
    appendSpec(chain, l2Ref);
    expect(chain).toHaveLength(1);
  });
});
