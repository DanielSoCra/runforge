import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../lib/git.js';
import { reconcileWorkspace } from './workspace.js';

async function makeRepo(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'workspace-test-'));
  await git(['init', '-q', '-b', 'dev'], repoRoot);
  await git(['config', 'user.email', 'test@test'], repoRoot);
  await git(['config', 'user.name', 'test'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'init\n');
  await git(['add', '.'], repoRoot);
  await git(['commit', '-q', '-m', 'init'], repoRoot);
  const remoteDir = await mkdtemp(join(tmpdir(), 'workspace-remote-'));
  await git(['init', '-q', '--bare', '-b', 'dev'], remoteDir);
  await git(['remote', 'add', 'origin', remoteDir], repoRoot);
  await git(['push', '-q', '-u', 'origin', 'dev'], repoRoot);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    },
  };
}

describe('reconcileWorkspace', () => {
  let repo: Awaited<ReturnType<typeof makeRepo>>;
  beforeEach(async () => { repo = await makeRepo(); });
  afterEach(async () => { await repo.cleanup(); });

  it('creates new worktree off staging when nothing exists', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-1');
    const result = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/1',
      stagingBranch: 'dev',
    });
    expect(result.ok).toBe(true);
    expect(existsSync(workspaceDir)).toBe(true);
    const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir);
    expect(branchResult.ok).toBe(true);
    if (branchResult.ok) expect(branchResult.value.trim()).toBe('feature/1');
  });

  it('reuses existing local branch when branch already exists', async () => {
    await git(['branch', 'feature/2', 'dev'], repo.repoRoot);
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-2');
    const result = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/2',
      stagingBranch: 'dev',
    });
    expect(result.ok).toBe(true);
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('returns success when workspace already present', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-3');
    await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/3',
      stagingBranch: 'dev',
    });
    const second = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/3',
      stagingBranch: 'dev',
    });
    expect(second.ok).toBe(true);
  });

  it('two concurrent calls both succeed (TOCTOU re-check)', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-concurrent');
    const opts = {
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/concurrent',
      stagingBranch: 'dev',
    };
    const [a, b] = await Promise.all([reconcileWorkspace(opts), reconcileWorkspace(opts)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('recovers when worktree registration is orphaned', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-4');
    await git(['worktree', 'add', workspaceDir, '-b', 'feature/4', 'dev'], repo.repoRoot);
    await rm(workspaceDir, { recursive: true, force: true });
    const result = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/4',
      stagingBranch: 'dev',
    });
    expect(result.ok).toBe(true);
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('regression #484: succeeds when local branch has no upstream', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-484');
    await git(['branch', 'feature/484', 'dev'], repo.repoRoot);
    await git(['worktree', 'add', workspaceDir, 'feature/484'], repo.repoRoot);
    const upstream = await git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      workspaceDir,
    );
    expect(upstream.ok).toBe(false);
    const result = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/484',
      stagingBranch: 'dev',
    });
    expect(result.ok).toBe(true);
  });
});
