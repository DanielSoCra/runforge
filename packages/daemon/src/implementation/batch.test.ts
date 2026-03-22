// src/implementation/batch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeBatch, type UnitResult } from './batch.js';
import type { Unit, SessionResult } from '../types.js';
import { ok, err } from '../lib/result.js';
import { createWorktree, getWorktreeDiffSize } from './worktree.js';

// Mock the worktree module
vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn().mockResolvedValue({ ok: true, value: '/tmp/workspace' }),
  removeWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  getWorktreeDiffSize: vi.fn().mockResolvedValue({ ok: true, value: 50 }),
}));

const makeUnit = (id: string, batch: number = 0): Unit => ({
  id, title: id, specIds: [], specContent: 'spec content',
  expectedArtifacts: [], dependencies: [], batchNumber: batch,
  verificationCommand: 'vitest run', context: 'implement something',
});

const successResult: SessionResult = {
  output: 'done', structuredData: null, cost: 0.5,
  pitfallMarkers: [], exitStatus: 'completed',
};

function createMockRuntime(result: SessionResult = successResult) {
  return {
    spawnSession: vi.fn().mockResolvedValue(ok(result)),
    getCostTracker: vi.fn(),
  } as any;
}

describe('executeBatch', () => {
  it('executes all units and returns results', async () => {
    const runtime = createMockRuntime();
    const units = [makeUnit('a'), makeUnit('b')];
    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.exitStatus).toBe('completed');
    expect(result.results[1]?.exitStatus).toBe('completed');
  });

  it('tracks total cost across units', async () => {
    const runtime = createMockRuntime();
    const units = [makeUnit('a'), makeUnit('b')];
    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });
    expect(result.totalCost).toBe(1.0); // 0.5 + 0.5
  });

  it('handles individual unit failures without affecting siblings', async () => {
    const failResult: SessionResult = {
      output: 'error', structuredData: null, cost: 0.2,
      pitfallMarkers: [], exitStatus: 'failed',
    };
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok(successResult))
        .mockResolvedValueOnce(ok(failResult)),
      getCostTracker: vi.fn(),
    } as any;
    const units = [makeUnit('a'), makeUnit('b')];
    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });
    expect(result.results[0]?.exitStatus).toBe('completed');
    expect(result.results[1]?.exitStatus).toBe('failed');
  });

  it('spawns worker sessions with unit context', async () => {
    const runtime = createMockRuntime();
    const unit = makeUnit('a');
    unit.context = 'build the widget';
    unit.specContent = 'widget spec';
    await executeBatch([unit], 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'worker',
      expect.objectContaining({
        variables: expect.objectContaining({
          task: 'build the widget',
          specs: 'widget spec',
        }),
      }),
      1,
      undefined,
      undefined,
      undefined,
    );
  });

  it('returns empty results for empty batch', async () => {
    const runtime = createMockRuntime();
    const result = await executeBatch([], 'feature/1', 1, runtime, '/tmp/repo');
    expect(result.results).toHaveLength(0);
    expect(result.totalCost).toBe(0);
  });

  it('stores pitfall markers as gotchas when GotchaStore is provided (#44)', async () => {
    const markers = [
      { artifactPatterns: ['src/**/*.ts'], description: 'Watch out for circular imports' },
    ];
    const resultWithPitfalls: SessionResult = {
      output: 'done', structuredData: null, cost: 0.5,
      pitfallMarkers: markers, exitStatus: 'completed',
    };
    const runtime = createMockRuntime(resultWithPitfalls);
    const gotchaStore = { store: vi.fn().mockResolvedValue(1) } as any;
    const units = [makeUnit('a')];

    await executeBatch(units, 'feature/42', 42, runtime, '/tmp/repo', { staggerMs: 0 }, undefined, undefined, undefined, gotchaStore);

    expect(gotchaStore.store).toHaveBeenCalledWith(markers, 42);
  });

  it('does not call GotchaStore.store when no pitfall markers exist (#44)', async () => {
    const runtime = createMockRuntime(); // successResult has empty pitfallMarkers
    const gotchaStore = { store: vi.fn().mockResolvedValue(0) } as any;
    const units = [makeUnit('a')];

    await executeBatch(units, 'feature/42', 42, runtime, '/tmp/repo', { staggerMs: 0 }, undefined, undefined, undefined, gotchaStore);

    expect(gotchaStore.store).not.toHaveBeenCalled();
  });

  it('propagates pitfallMarkers through UnitResult (#44)', async () => {
    const markers = [
      { artifactPatterns: ['src/foo.ts'], description: 'Foo needs bar' },
    ];
    const resultWithPitfalls: SessionResult = {
      output: 'done', structuredData: null, cost: 0.3,
      pitfallMarkers: markers, exitStatus: 'completed',
    };
    const runtime = createMockRuntime(resultWithPitfalls);
    const units = [makeUnit('a')];

    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });

    expect(result.results[0]?.pitfallMarkers).toEqual(markers);
  });

  it('handles GotchaStore.store failure gracefully (#44)', async () => {
    const markers = [
      { artifactPatterns: ['src/**'], description: 'a pitfall' },
    ];
    const resultWithPitfalls: SessionResult = {
      output: 'done', structuredData: null, cost: 0.5,
      pitfallMarkers: markers, exitStatus: 'completed',
    };
    const runtime = createMockRuntime(resultWithPitfalls);
    const gotchaStore = { store: vi.fn().mockRejectedValue(new Error('disk full')) } as any;
    const units = [makeUnit('a')];

    // Should not throw — gotcha storage failure should not break the batch
    const result = await executeBatch(units, 'feature/42', 42, runtime, '/tmp/repo', { staggerMs: 0 }, undefined, undefined, undefined, gotchaStore);

    expect(result.results[0]?.exitStatus).toBe('completed');
    expect(gotchaStore.store).toHaveBeenCalled();
  });

  it('returns failed when worktree creation fails (#64)', async () => {
    vi.mocked(createWorktree).mockResolvedValueOnce(
      err(new Error('index.lock exists')),
    );
    const runtime = createMockRuntime();
    const units = [makeUnit('a')];

    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });

    expect(result.results[0]?.exitStatus).toBe('failed');
    expect(result.results[0]?.error).toContain('Worktree creation failed');
    expect(result.results[0]?.cost).toBe(0);
    // Session should never be spawned when worktree fails
    expect(runtime.spawnSession).not.toHaveBeenCalled();
  });

  it('returns failed when diff size exceeds maxDiffLines (#64)', async () => {
    vi.mocked(getWorktreeDiffSize).mockResolvedValueOnce({ ok: true, value: 500 });
    const runtime = createMockRuntime();
    const units = [makeUnit('a')];

    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', {
      staggerMs: 0,
      maxDiffLines: 300,
    });

    expect(result.results[0]?.exitStatus).toBe('failed');
    expect(result.results[0]?.error).toContain('Diff size 500 exceeds limit of 300');
    // Cost should still be tracked even though the unit was rejected
    expect(result.results[0]?.cost).toBe(0.5);
  });

  it('returns failed when getWorktreeDiffSize returns an error (#141)', async () => {
    vi.mocked(getWorktreeDiffSize).mockResolvedValueOnce(
      err(new Error('bad revision')),
    );
    const runtime = createMockRuntime();
    const units = [makeUnit('a')];

    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });

    expect(result.results[0]?.exitStatus).toBe('failed');
    expect(result.results[0]?.error).toContain('Diff size check failed');
    expect(result.results[0]?.error).toContain('bad revision');
    // Cost should still be tracked — session ran successfully before diff check failed
    expect(result.results[0]?.cost).toBe(0.5);
  });

  it('propagates timed-out exit status through UnitResult (#64)', async () => {
    const timedOutResult: SessionResult = {
      output: 'timed out waiting', structuredData: null, cost: 1.2,
      pitfallMarkers: [], exitStatus: 'timed-out',
    };
    const runtime = createMockRuntime(timedOutResult);
    const units = [makeUnit('a')];

    const result = await executeBatch(units, 'feature/1', 1, runtime, '/tmp/repo', { staggerMs: 0 });

    expect(result.results[0]?.exitStatus).toBe('timed-out');
    expect(result.results[0]?.cost).toBe(1.2);
  });
});
