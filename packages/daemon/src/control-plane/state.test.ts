// src/control-plane/state.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateManager } from './state.js';
import type { RunState } from '../types.js';

const makeRun = (issueNumber: number, phase: string = 'implement'): RunState => ({
  id: 'test-run-id',
  issueNumber,
  title: `Test issue ${issueNumber}`,
  phase: phase as any,
  variant: 'feature-simple',
  phaseCompletions: {},
  checkpoints: [],
  cost: 0,
  perRunBudget: 10,
  fixAttempts: [],
  errorHashes: {},
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('StateManager', () => {
  let dir: string;
  let mgr: StateManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'state-'));
    mgr = new StateManager(dir);
    await mgr.initialize();
  });

  it('saves and loads RunState', async () => {
    const run = makeRun(42);
    await mgr.saveRunState(run);
    const loaded = await mgr.loadRunState(42);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.issueNumber).toBe(42);
  });

  it('returns err for missing RunState', async () => {
    const loaded = await mgr.loadRunState(999);
    expect(loaded.ok).toBe(false);
  });

  it('saves and loads DaemonState', async () => {
    const state = { pid: 1234, uptimeStart: '', dailyCost: 0, dailyResetAt: '', paused: false, consecutiveStuckCount: 0, maxConcurrentRuns: 1 };
    await mgr.saveDaemonState(state);
    const loaded = await mgr.loadDaemonState();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.pid).toBe(1234);
  });

  it('finds incomplete runs', async () => {
    await mgr.saveRunState(makeRun(1, 'implement'));
    await mgr.saveRunState(makeRun(2, 'review'));
    await mgr.saveRunState(makeRun(3, 'stuck')); // complete
    const incomplete = await mgr.findIncompleteRuns();
    expect(incomplete).toHaveLength(2);
    expect(incomplete.map((r) => r.issueNumber).sort()).toEqual([1, 2]);
  });

  it('warns when incomplete run scan fails (#567)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await rm(join(dir, 'runs'), { recursive: true, force: true });

      const incomplete = await mgr.findIncompleteRuns();

      expect(incomplete).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[state] failed to scan incomplete runs:',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('cleans up .tmp files on initialize', async () => {
    await writeFile(join(dir, 'stale.tmp'), 'garbage');
    await mgr.initialize();
    const { readdir } = await import('fs/promises');
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('treats completed report phase as complete', async () => {
    const run = makeRun(1, 'report');
    run.phaseCompletions = { report: true };
    await mgr.saveRunState(run);
    const incomplete = await mgr.findIncompleteRuns();
    expect(incomplete).toHaveLength(0);
  });

  it('treats completed launch phase as complete (website pipeline)', async () => {
    const run = makeRun(1, 'launch');
    run.variant = 'website' as any;
    run.phaseCompletions = { launch: true };
    await mgr.saveRunState(run);
    const incomplete = await mgr.findIncompleteRuns();
    expect(incomplete).toHaveLength(0);
  });

  it('treats launch phase without completion as incomplete', async () => {
    const run = makeRun(1, 'launch');
    run.variant = 'website' as any;
    run.phaseCompletions = {};
    await mgr.saveRunState(run);
    const incomplete = await mgr.findIncompleteRuns();
    expect(incomplete).toHaveLength(1);
  });

  it('deletes RunState', async () => {
    await mgr.saveRunState(makeRun(42));
    await mgr.deleteRunState(42);
    const loaded = await mgr.loadRunState(42);
    expect(loaded.ok).toBe(false);
  });
});
