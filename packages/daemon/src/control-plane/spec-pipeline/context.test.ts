// context.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildL2Context, buildL3Context, buildImplementContext, buildComplianceContext } from './context.js';
import type { SpecChain, SpecReference } from './spec-chain.js';

let root: string;

const l1Content = '# L1 Functional Spec\nBehavior: detect work requests';
const l2Content = '# L2 Architecture Spec\nBoundary: control plane owns FSM';
const l3Content = '# L3 Stack Spec\nPattern: frozen phase definition';

const l1Ref: SpecReference = { layer: 'l1', specId: 'FUNC-AC-PIPELINE', filePath: '.specify/functional/pipeline.md', branch: 'dev' };
const l2Ref: SpecReference = { layer: 'l2', specId: 'ARCH-AC-SPEC-PIPELINE', filePath: '.specify/architecture/spec-pipeline.md', branch: 'spec/l2/200' };
const l3Ref: SpecReference = { layer: 'l3', specId: 'STACK-AC-SPEC-PIPELINE', filePath: '.specify/stack/spec-pipeline-ts.md', branch: 'spec/l3/200' };

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-test-'));
  await mkdir(join(root, '.specify/functional'), { recursive: true });
  await mkdir(join(root, '.specify/architecture'), { recursive: true });
  await mkdir(join(root, '.specify/stack'), { recursive: true });
  await writeFile(join(root, l1Ref.filePath), l1Content);
  await writeFile(join(root, l2Ref.filePath), l2Content);
  await writeFile(join(root, l3Ref.filePath), l3Content);
});

describe('buildL2Context', () => {
  it('reads L1 content from chain', async () => {
    const ctx = await buildL2Context([l1Ref], root);
    expect(ctx.l1Content).toBe(l1Content);
  });

  it('includes existing L2 specs', async () => {
    const ctx = await buildL2Context([l1Ref], root);
    expect(ctx.existingL2Specs.length).toBeGreaterThanOrEqual(1);
    expect(ctx.existingL2Specs[0]).toContain('L2 Architecture Spec');
  });

  it('passes through feedback', async () => {
    const ctx = await buildL2Context([l1Ref], root, 'Revise section 3');
    expect(ctx.feedback).toBe('Revise section 3');
  });

  it('throws when L1 is missing from chain', async () => {
    await expect(buildL2Context([], root)).rejects.toThrow('missing L1');
  });
});

describe('buildL3Context', () => {
  it('reads L1 + L2 content from chain', async () => {
    const ctx = await buildL3Context([l1Ref, l2Ref], root);
    expect(ctx.l1Content).toBe(l1Content);
    expect(ctx.l2Content).toBe(l2Content);
  });

  it('includes existing L3 specs', async () => {
    const ctx = await buildL3Context([l1Ref, l2Ref], root);
    expect(ctx.existingL3Specs.length).toBeGreaterThanOrEqual(1);
  });

  it('throws when L2 is missing', async () => {
    await expect(buildL3Context([l1Ref], root)).rejects.toThrow('missing L2');
  });
});

describe('buildImplementContext', () => {
  it('reads full spec chain', async () => {
    const chain: SpecChain = [l1Ref, l2Ref, l3Ref];
    const ctx = await buildImplementContext(chain, root);
    expect(ctx.l1Content).toBe(l1Content);
    expect(ctx.l2Content).toBe(l2Content);
    expect(ctx.l3Content).toBe(l3Content);
  });

  it('throws when chain is incomplete', async () => {
    await expect(buildImplementContext([l1Ref, l2Ref], root)).rejects.toThrow('incomplete');
  });
});

describe('buildComplianceContext', () => {
  it('reads full spec chain', async () => {
    const chain: SpecChain = [l1Ref, l2Ref, l3Ref];
    const ctx = await buildComplianceContext(chain, root);
    expect(ctx.l1Content).toBe(l1Content);
    expect(ctx.l2Content).toBe(l2Content);
    expect(ctx.l3Content).toBe(l3Content);
  });

  it('throws when chain is incomplete', async () => {
    await expect(buildComplianceContext([l1Ref], root)).rejects.toThrow('incomplete');
  });
});
