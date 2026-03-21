import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktree, removeWorktree, listWorktrees, mergeWorktree, getWorktreeDiffSize } from './worktree.js';
import { git } from '../lib/git.js';

describe('worktree management', () => {
  let repoDir: string;

  beforeEach(async () => {
    // Create a temporary git repo
    repoDir = await mkdtemp(join(tmpdir(), 'worktree-test-'));
    await git(['init'], repoDir);
    await git(['checkout', '-b', 'main'], repoDir);
    // Need at least one commit for worktrees to work
    const { writeFile } = await import('fs/promises');
    await writeFile(join(repoDir, 'README.md'), '# Test');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'initial'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('creates a worktree and returns its path', async () => {
    const result = await createWorktree('unit-1', 'main', repoDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('workspaces/unit-1');
    }
  });

  it('removes a worktree', async () => {
    await createWorktree('unit-2', 'main', repoDir);
    const result = await removeWorktree('unit-2', repoDir);
    expect(result.ok).toBe(true);
  });

  it('lists worktrees', async () => {
    await createWorktree('unit-3', 'main', repoDir);
    const result = await listWorktrees(repoDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThanOrEqual(2); // main + worktree
    }
  });

  it('merges worktree into target branch', async () => {
    const createResult = await createWorktree('unit-4', 'main', repoDir);
    if (!createResult.ok) throw new Error('Failed to create worktree');

    // Make a change in the worktree
    const { writeFile } = await import('fs/promises');
    await writeFile(join(createResult.value, 'new-file.txt'), 'content');
    await git(['add', '.'], createResult.value);
    await git(['commit', '-m', 'add file'], createResult.value);

    // Merge back into main
    const mergeResult = await mergeWorktree('unit-4', 'main', repoDir);
    expect(mergeResult.ok).toBe(true);
  });

  it('returns error for non-existent base branch', async () => {
    const result = await createWorktree('unit-bad', 'nonexistent', repoDir);
    expect(result.ok).toBe(false);
  });

  it('getWorktreeDiffSize returns correct insertion+deletion count', async () => {
    const createResult = await createWorktree('unit-diff', 'main', repoDir);
    if (!createResult.ok) throw new Error('Failed to create worktree');

    // Make changes in the worktree
    const { writeFile } = await import('fs/promises');
    await writeFile(join(createResult.value, 'new-file.txt'), 'line1\nline2\nline3\n');
    await git(['add', '.'], createResult.value);
    await git(['commit', '-m', 'add 3 lines'], createResult.value);

    const diffResult = await getWorktreeDiffSize('unit-diff', 'main', repoDir);
    expect(diffResult.ok).toBe(true);
    if (diffResult.ok) {
      // 3 insertions from new-file.txt
      expect(diffResult.value).toBe(3);
    }
  });

  it('getWorktreeDiffSize returns 0 for no changes', async () => {
    await createWorktree('unit-nodiff', 'main', repoDir);

    const diffResult = await getWorktreeDiffSize('unit-nodiff', 'main', repoDir);
    expect(diffResult.ok).toBe(true);
    if (diffResult.ok) {
      expect(diffResult.value).toBe(0);
    }
  });
});
