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
