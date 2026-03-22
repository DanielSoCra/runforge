// src/implementation/context.test.ts
import { describe, it, expect } from 'vitest';
import { assembleWorkerContext, assembleCoordinatorContext } from './context.js';

describe('assembleWorkerContext', () => {
  it('orders spec content as L3 → L2 → L1 (implementation order)', () => {
    const result = assembleWorkerContext({
      l1Content: '# L1 Business',
      l2Content: '# L2 Architecture',
      l3Content: '# L3 Patterns',
      unitContext: 'Build the widget',
      verificationCommand: 'vitest run',
    });
    const l3Pos = result.indexOf('# L3 Patterns');
    const l2Pos = result.indexOf('# L2 Architecture');
    const l1Pos = result.indexOf('# L1 Business');
    expect(l3Pos).toBeLessThan(l2Pos);
    expect(l2Pos).toBeLessThan(l1Pos);
  });

  it('includes unit context and verification command', () => {
    const result = assembleWorkerContext({
      l1Content: 'l1',
      l2Content: 'l2',
      l3Content: 'l3',
      unitContext: 'Do the thing',
      verificationCommand: 'pnpm test',
    });
    expect(result).toContain('Do the thing');
    expect(result).toContain('pnpm test');
  });

  it('includes pitfalls section when provided', () => {
    const result = assembleWorkerContext({
      l1Content: 'l1',
      l2Content: 'l2',
      l3Content: 'l3',
      unitContext: 'task',
      verificationCommand: 'test',
      pitfalls: '- Watch out for null returns',
    });
    expect(result).toContain('Watch out for null returns');
  });

  it('omits pitfalls section when empty', () => {
    const result = assembleWorkerContext({
      l1Content: 'l1',
      l2Content: 'l2',
      l3Content: 'l3',
      unitContext: 'task',
      verificationCommand: 'test',
    });
    expect(result).not.toContain('Pitfalls');
  });
});

describe('assembleCoordinatorContext', () => {
  it('orders spec content as L1 → L2 → L3 (understanding order)', () => {
    const result = assembleCoordinatorContext({
      l1Content: '# L1 Business',
      l2Content: '# L2 Architecture',
      l3Content: '# L3 Patterns',
      workRequest: 'Add feature X',
      traceabilityMap: 'SPEC-1: ...',
    });
    const l1Pos = result.indexOf('# L1 Business');
    const l2Pos = result.indexOf('# L2 Architecture');
    const l3Pos = result.indexOf('# L3 Patterns');
    expect(l1Pos).toBeLessThan(l2Pos);
    expect(l2Pos).toBeLessThan(l3Pos);
  });

  it('includes work request and traceability map', () => {
    const result = assembleCoordinatorContext({
      l1Content: 'l1',
      l2Content: 'l2',
      l3Content: 'l3',
      workRequest: 'Build something',
      traceabilityMap: 'FUNC-AC-PIPELINE: ...',
    });
    expect(result).toContain('Build something');
    expect(result).toContain('FUNC-AC-PIPELINE');
  });
});
