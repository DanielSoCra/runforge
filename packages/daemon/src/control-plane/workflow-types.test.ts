import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS } from './builtin-workflows.js';
import { validateWorkflowDefinition, type WorkflowDefinition } from './workflow-types.js';

describe('workflow definition validation', () => {
  it('accepts the built-in feature workflow', () => {
    const result = validateWorkflowDefinition(BUILTIN_WORKFLOWS.feature);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects a missing entry node', () => {
    const result = validateWorkflowDefinition({
      variant: 'bad-entry',
      entryNode: 'missing',
      nodes: {
        detect: { kind: 'task', phase: 'detect', owner: 'ControlPlane', next: undefined },
      },
      labelMap: { detect: 'detect' },
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('entryNode missing does not exist');
  });

  it('rejects unknown references', () => {
    const result = validateWorkflowDefinition({
      variant: 'bad-ref',
      entryNode: 'detect',
      nodes: {
        detect: { kind: 'task', phase: 'detect', owner: 'ControlPlane', next: 'unknown' },
      },
      labelMap: { detect: 'detect' },
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('node detect references unknown next node unknown');
  });

  it('rejects cycles in success edges', () => {
    const result = validateWorkflowDefinition({
      variant: 'cycle',
      entryNode: 'a',
      nodes: {
        a: { kind: 'task', phase: 'detect', owner: 'ControlPlane', next: 'b' },
        b: { kind: 'task', phase: 'classify', owner: 'ControlPlane', next: 'a' },
      },
      labelMap: { a: 'detect', b: 'classify' },
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('workflow graph contains a cycle');
  });

  it('requires label coverage for every node', () => {
    const result = validateWorkflowDefinition({
      variant: 'missing-label',
      entryNode: 'detect',
      nodes: {
        detect: { kind: 'task', phase: 'detect', owner: 'ControlPlane' },
      },
      labelMap: {},
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('labelMap missing node detect');
  });

  it('rejects a loop with an invalid inner entry', () => {
    const result = validateWorkflowDefinition({
      variant: 'bad-loop',
      entryNode: 'loop',
      nodes: {
        loop: {
          kind: 'loop',
          innerEntry: 'missing',
          exitOn: 'success',
          maxIterations: 2,
          iterationLabelPrefix: 'adversarial',
        },
      },
      labelMap: { loop: 'adversarial-loop' },
    } satisfies WorkflowDefinition);

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('node loop references unknown innerEntry node missing');
  });
});
