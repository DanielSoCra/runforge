// src/control-plane/pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPipeline, type PhaseHandlerMap } from './pipeline.js';
import { getPipeline } from './fsm.js';
import { StateManager } from './state.js';
import { CostTracker } from '../session-runtime/cost.js';
import type { RunState, PhaseEvent } from '../types.js';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const makeRun = (variant: 'feature' | 'feature-simple' | 'bug' = 'feature-simple'): RunState => ({
  id: 'test-run-id',
  issueNumber: 1,
  title: 'Test',
  phase: 'detect',
  variant,
  phaseCompletions: {},
  checkpoints: [],
  cost: 0,
  perRunBudget: 10,
  fixAttempts: [],
  errorHashes: {},
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('runPipeline', () => {
  let stateMgr: StateManager;
  let costTracker: CostTracker;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-'));
    stateMgr = new StateManager(dir);
    await stateMgr.initialize();
    costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
  });

  it('runs feature-simple pipeline to completion with all-success handlers', async () => {
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => 'success' as PhaseEvent,
      review: async () => 'success' as PhaseEvent,
      holdout: async () => 'success' as PhaseEvent,
      integrate: async () => 'success' as PhaseEvent,
      deploy: async () => 'success' as PhaseEvent,
      test: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('complete');
  });

  it('transitions to stuck after max retries on implement failure', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => { attempts++; return 'failure' as PhaseEvent; },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(attempts).toBe(3); // default max retries
  });

  it('pauses when budget exceeded', async () => {
    costTracker.recordCost(1, 51); // exceed daily budget
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
    };
    const run = makeRun();
    run.phase = 'implement';
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('paused');
  });

  it('pauses on budget-exceeded event from handler', async () => {
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => 'budget-exceeded' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('paused');
  });

  it('saves state after each phase transition', async () => {
    const saveSpy = vi.spyOn(stateMgr, 'saveRunState');
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => 'success' as PhaseEvent,
      review: async () => 'success' as PhaseEvent,
      holdout: async () => 'success' as PhaseEvent,
      integrate: async () => 'success' as PhaseEvent,
      deploy: async () => 'success' as PhaseEvent,
      test: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(saveSpy.mock.calls.length).toBeGreaterThan(5);
  });

  it('handles exceptions in phase handlers as failures', async () => {
    let attempts = 0;
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => { attempts++; throw new Error('boom'); },
    };
    const run = makeRun('feature-simple');
    const table = getPipeline('feature-simple');
    const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
    expect(result.outcome).toBe('stuck');
    expect(attempts).toBe(3);
  });

  it('calls runWriter.upsertRun on phase transitions', async () => {
    const upsertRun = vi.fn().mockResolvedValue(undefined);
    const runWriter = { upsertRun, writeCostEvent: vi.fn() } as any;

    const run = makeRun();
    const handlers: PhaseHandlerMap = {
      detect: async () => 'success' as PhaseEvent,
      classify: async () => 'success:simple' as PhaseEvent,
      implement: async () => 'success' as PhaseEvent,
      review: async () => 'success' as PhaseEvent,
      report: async () => 'success' as PhaseEvent,
    };
    await runPipeline(run, getPipeline('feature-simple'), handlers, stateMgr, costTracker, undefined, runWriter);
    expect(upsertRun).toHaveBeenCalled();
    const firstCall = upsertRun.mock.calls[0]!;
    expect(firstCall[0]).toBe('test-run-id');
    expect(firstCall[1]).toHaveProperty('current_phase');
  });
});
