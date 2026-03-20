// src/implementation/batch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeBatch, type UnitResult } from './batch.js';
import type { Unit, SessionResult } from '../types.js';
import { ok } from '../lib/result.js';

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
});
