import { describe, expect, it } from 'vitest';
import type { RunState } from '../types.js';
import { executeWorkflow } from './dag-executor.js';
import type { WorkflowDefinition } from './workflow-types.js';

function makeRun(): RunState {
  return {
    id: 'run-1',
    issueNumber: 483,
    title: 'DAG executor',
    phase: 'detect',
    variant: 'feature',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('executeWorkflow', () => {
  it('executes sequential task nodes and yields after each node completes', async () => {
    const workflow: WorkflowDefinition = {
      variant: 'test',
      entryNode: 'a',
      nodes: {
        a: { kind: 'task', phase: 'detect', owner: 'ControlPlane', next: 'b' },
        b: { kind: 'task', phase: 'classify', owner: 'ControlPlane' },
      },
      labelMap: { a: 'detect', b: 'classify' },
    };
    const calls: string[] = [];
    const yielded: string[] = [];

    for await (const run of executeWorkflow(workflow, makeRun(), {
      dispatchTask: async (node) => {
        calls.push(node.phase);
        return 'success';
      },
    })) {
      yielded.push(run.currentNodeId ?? '');
    }

    expect(calls).toEqual(['detect', 'classify']);
    expect(yielded).toEqual(['a', 'b']);
  });

  it('runs parallel children concurrently and advances after fan-in', async () => {
    const workflow: WorkflowDefinition = {
      variant: 'parallel',
      entryNode: 'review-group',
      nodes: {
        'review-group': {
          kind: 'parallel',
          children: ['quality', 'security'],
          policy: 'continue-all',
          next: 'report',
        },
        quality: { kind: 'task', phase: 'review', owner: 'ValidationService' },
        security: { kind: 'task', phase: 'review', owner: 'ValidationService' },
        report: { kind: 'task', phase: 'report', owner: 'ControlPlane' },
      },
      labelMap: {
        'review-group': 'review',
        quality: 'review:quality',
        security: 'review:security',
        report: 'report',
      },
    };
    let inFlight = 0;
    let maxInFlight = 0;

    for await (const run of executeWorkflow(workflow, makeRun(), {
      dispatchTask: async (node) => {
        if (node.phase === 'review') {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
        }
        return 'success';
      },
    })) {
      expect(run.currentNodeId).toBeDefined();
    }

    expect(maxInFlight).toBe(2);
  });

  it('aborts remaining parallel children on fail-fast failure', async () => {
    const workflow: WorkflowDefinition = {
      variant: 'parallel-fail',
      entryNode: 'review-group',
      nodes: {
        'review-group': {
          kind: 'parallel',
          children: ['quality', 'security'],
          policy: 'fail-fast',
          failNext: 'report',
        },
        quality: { kind: 'task', phase: 'review', owner: 'ValidationService' },
        security: { kind: 'task', phase: 'review', owner: 'ValidationService' },
        report: { kind: 'task', phase: 'report', owner: 'ControlPlane' },
      },
      labelMap: {
        'review-group': 'review',
        quality: 'review:quality',
        security: 'review:security',
        report: 'report',
      },
    };
    let sawAbort = false;

    for await (const run of executeWorkflow(workflow, makeRun(), {
      dispatchTask: async (_node, _run, signal, nodeId) => {
        if (nodeId === 'quality') return 'failure';
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (signal.aborted) {
          sawAbort = true;
          return 'failure';
        }
        return 'success';
      },
    })) {
      if (run.currentNodeId === 'report') break;
    }

    expect(sawAbort).toBe(true);
  });

  it('repeats a loop until the inner workflow succeeds', async () => {
    const workflow: WorkflowDefinition = {
      variant: 'loop',
      entryNode: 'adversarial-loop',
      nodes: {
        'adversarial-loop': {
          kind: 'loop',
          innerEntry: 'challenge',
          exitOn: 'success',
          maxIterations: 3,
          iterationLabelPrefix: 'adversarial',
          next: 'report',
        },
        challenge: { kind: 'task', phase: 'review', owner: 'ValidationService' },
        report: { kind: 'task', phase: 'report', owner: 'ControlPlane' },
      },
      labelMap: {
        'adversarial-loop': 'adversarial-loop',
        challenge: 'adversarial:challenge',
        report: 'report',
      },
    };
    let attempts = 0;

    for await (const run of executeWorkflow(workflow, makeRun(), {
      dispatchTask: async (node) => {
        if (node.phase === 'review') {
          attempts++;
          return attempts === 2 ? 'success' : 'failure';
        }
        return 'success';
      },
    })) {
      if (run.currentNodeId === 'report') break;
    }

    expect(attempts).toBe(2);
  });

  it('marks thrown task errors as failed node state with an error hash', async () => {
    const workflow: WorkflowDefinition = {
      variant: 'task-error',
      entryNode: 'implement',
      nodes: {
        implement: { kind: 'task', phase: 'implement', owner: 'ImplementationCoordinator' },
      },
      labelMap: { implement: 'implement' },
    };
    const run = makeRun();

    const yielded: RunState[] = [];
    for await (const state of executeWorkflow(workflow, run, {
      dispatchTask: async () => {
        throw new Error('worker crashed at 10:12:44');
      },
    })) {
      yielded.push(state);
    }

    expect(yielded).toHaveLength(1);
    expect(run.nodeStates?.implement?.status).toBe('failed');
    expect(run.nodeStates?.implement?.lastEvent).toBe('failure');
    expect(run.nodeStates?.implement?.errorHash).toMatch(/^[a-f0-9]{16}$/);
  });
});
