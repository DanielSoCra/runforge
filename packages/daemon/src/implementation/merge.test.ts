// src/implementation/merge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeUnitsSequentially } from './merge.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import { ok, err } from '../lib/result.js';

// Mock worktree and git
vi.mock('./worktree.js', () => ({
  mergeWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  deleteUnitBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
}));

vi.mock('../lib/git.js', () => ({
  git: vi.fn().mockResolvedValue({ ok: true, value: '' }),
}));

describe('mergeUnitsSequentially', () => {
  beforeEach(async () => {
    const { mergeWorktree, deleteUnitBranch } = await import('./worktree.js');
    vi.mocked(mergeWorktree).mockClear().mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(deleteUnitBranch).mockClear().mockResolvedValue({ ok: true, value: undefined });
  });

  it('merges all units in order and cleans up branches', async () => {
    const { mergeWorktree, deleteUnitBranch } = await import('./worktree.js');
    const unitIds = ['unit-a', 'unit-b', 'unit-c'];
    const result = await mergeUnitsSequentially(unitIds, 'feature/42', '/tmp/repo');

    expect(result.ok).toBe(true);
    expect(mergeWorktree).toHaveBeenCalledTimes(3);
    expect(mergeWorktree).toHaveBeenNthCalledWith(1, 'unit-a', 'feature/42', '/tmp/repo');
    expect(mergeWorktree).toHaveBeenNthCalledWith(2, 'unit-b', 'feature/42', '/tmp/repo');
    expect(mergeWorktree).toHaveBeenNthCalledWith(3, 'unit-c', 'feature/42', '/tmp/repo');
    expect(deleteUnitBranch).toHaveBeenCalledTimes(3);
  });

  it('returns error when merge fails for a unit', async () => {
    const { mergeWorktree } = await import('./worktree.js');
    vi.mocked(mergeWorktree)
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce(err(new Error('CONFLICT: merge conflict')));

    const result = await mergeUnitsSequentially(
      ['unit-a', 'unit-b', 'unit-c'],
      'feature/42',
      '/tmp/repo',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('unit-b');
      expect(result.error.message).toContain('CONFLICT');
    }
  });

  it('succeeds with empty unit list', async () => {
    const result = await mergeUnitsSequentially([], 'feature/42', '/tmp/repo');
    expect(result.ok).toBe(true);
  });

  it('cleans up remaining unmerged and failed branches on partial merge failure (#385)', async () => {
    const { mergeWorktree, deleteUnitBranch } = await import('./worktree.js');
    vi.mocked(mergeWorktree)
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce(err(new Error('CONFLICT')));

    const result = await mergeUnitsSequentially(
      ['unit-a', 'unit-b', 'unit-c'],
      'feature/42',
      '/tmp/repo',
      ['unit-fail-1', 'unit-fail-2'],
    );

    expect(result.ok).toBe(false);
    // unit-a branch cleaned up after successful merge
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-a', '/tmp/repo');
    // unit-b (failed merge) and unit-c (never attempted) should be cleaned up
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-b', '/tmp/repo');
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-c', '/tmp/repo');
    // Failed unit branches should also be cleaned up
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-fail-1', '/tmp/repo');
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-fail-2', '/tmp/repo');
    // Total: unit-a (post-merge) + unit-b + unit-c (remaining) + unit-fail-1 + unit-fail-2
    expect(deleteUnitBranch).toHaveBeenCalledTimes(5);
  });

  it('cleans up branches for failed units', async () => {
    const { deleteUnitBranch } = await import('./worktree.js');
    const result = await mergeUnitsSequentially(
      ['unit-a'],
      'feature/42',
      '/tmp/repo',
      ['unit-fail'],
    );

    expect(result.ok).toBe(true);
    // Should clean up the failed unit branch too
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-fail', '/tmp/repo');
  });
});
