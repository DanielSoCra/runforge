import { describe, expect, it } from 'vitest';
import type { RunState } from '../types.js';
import { BUILTIN_WORKFLOWS } from './builtin-workflows.js';
import { migrateRunStateToWorkflow } from './run-state-migration.js';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    issueNumber: 483,
    title: 'DAG executor',
    phase: 'review',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true, implement: true },
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('migrateRunStateToWorkflow', () => {
  it('initializes node states from old phase completions', () => {
    const run = makeRun();

    const migrated = migrateRunStateToWorkflow(run, BUILTIN_WORKFLOWS['feature-simple']);

    expect(migrated.nodeStates?.detect?.status).toBe('succeeded');
    expect(migrated.nodeStates?.classify?.status).toBe('succeeded');
    expect(migrated.nodeStates?.implement?.status).toBe('succeeded');
    expect(migrated.nodeStates?.review?.status).toBe('running');
    expect(migrated.nodeStates?.holdout?.status).toBe('pending');
    expect(migrated.currentNodeId).toBe('review');
    expect(migrated.activeNodeIds).toEqual(['review']);
  });

  it('preserves existing migrated node state', () => {
    const run = makeRun({
      nodeStates: {
        detect: { nodeId: 'detect', status: 'succeeded', completedAt: '2026-05-04T00:00:00.000Z' },
      },
      currentNodeId: 'detect',
      activeNodeIds: [],
    });

    const migrated = migrateRunStateToWorkflow(run, BUILTIN_WORKFLOWS['feature-simple']);

    expect(migrated.nodeStates?.detect?.completedAt).toBe('2026-05-04T00:00:00.000Z');
    expect(migrated.currentNodeId).toBe('detect');
  });

  it('falls back to the workflow entry when the current phase has no matching node', () => {
    const run = makeRun({ phase: 'paused', phaseCompletions: {} });

    const migrated = migrateRunStateToWorkflow(run, BUILTIN_WORKFLOWS['feature-simple']);

    expect(migrated.currentNodeId).toBe('detect');
    expect(migrated.activeNodeIds).toEqual([]);
  });
});
