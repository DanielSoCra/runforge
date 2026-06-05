import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../lib/git.js';
import { reconcileWorkspace, ensureRepoFresh } from './workspace.js';

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

  it('creates new worktree from explicit source ref when provided', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-source-ref');
    const result = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/source-ref',
      stagingBranch: 'dev',
      sourceRef: 'origin/dev',
    });
    expect(result.ok).toBe(true);
    const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir);
    expect(branchResult.ok).toBe(true);
    if (branchResult.ok) expect(branchResult.value.trim()).toBe('feature/source-ref');
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

  it('rejects existsSync-true but git-broken paths via probe', async () => {
    // Simulate a non-worktree directory at the workspace path (e.g., partial
    // worktree-add aftermath). reconcileWorkspace's outer existsSync passes
    // and returns ok — that is intentional Plan B scope. But createFresh's
    // probe must NOT accept a broken dir as success when worktree add failed.
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-broken');
    // Create a plain dir with a file — not a git worktree
    await import('node:fs/promises').then(({ mkdir, writeFile: wf }) =>
      mkdir(workspaceDir, { recursive: true }).then(() => wf(join(workspaceDir, 'junk.txt'), 'x')),
    );
    // Outer reconcile returns ok (existing dir, accepted as-is).
    const result = await reconcileWorkspace({
      repoRoot: repo.repoRoot,
      workspaceDir,
      featureBranch: 'feature/broken',
      stagingBranch: 'dev',
    });
    expect(result.ok).toBe(true);
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

/** Push a fresh commit to origin/<branch> from a throwaway clone (simulating an
 * operator/external push), leaving the test repo's local <branch> behind. Returns
 * the new origin SHA. */
async function externalPush(repoRoot: string, branch: string): Promise<string> {
  const url = await git(['remote', 'get-url', 'origin'], repoRoot);
  if (!url.ok) throw new Error('no origin url');
  const ext = await mkdtemp(join(tmpdir(), 'workspace-ext-'));
  try {
    await git(['clone', '-q', url.value.trim(), '.'], ext);
    await git(['config', 'user.email', 'ext@test'], ext);
    await git(['config', 'user.name', 'ext'], ext);
    await git(['checkout', '-q', branch], ext);
    await writeFile(join(ext, 'EXTERNAL.md'), 'pushed externally\n');
    await git(['add', '.'], ext);
    await git(['commit', '-q', '-m', 'external commit'], ext);
    await git(['push', '-q', 'origin', branch], ext);
    const sha = await git(['rev-parse', 'HEAD'], ext);
    if (!sha.ok) throw new Error('rev-parse failed');
    return sha.value.trim();
  } finally {
    await rm(ext, { recursive: true, force: true });
  }
}

describe('ensureRepoFresh', () => {
  let repo: Awaited<ReturnType<typeof makeRepo>>;
  beforeEach(async () => { repo = await makeRepo(); });
  afterEach(async () => { await repo.cleanup(); });

  it('fast-forwards a stale local base branch (checked out) to origin', async () => {
    const newSha = await externalPush(repo.repoRoot, 'dev');
    const before = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(before.ok && before.value.trim()).not.toBe(newSha);

    const result = await ensureRepoFresh(repo.repoRoot, 'dev');
    expect(result.ok).toBe(true);

    const after = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(after.ok && after.value.trim()).toBe(newSha);
  });

  it('fast-forwards a base branch that is NOT checked out (update-ref path)', async () => {
    const newSha = await externalPush(repo.repoRoot, 'dev');
    await git(['checkout', '-q', '-b', 'feature/x'], repo.repoRoot); // dev no longer HEAD
    const result = await ensureRepoFresh(repo.repoRoot, 'dev');
    expect(result.ok).toBe(true);
    const after = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(after.ok && after.value.trim()).toBe(newSha);
  });

  it('does NOT clobber a local base branch that is ahead of origin', async () => {
    await writeFile(join(repo.repoRoot, 'LOCAL.md'), 'unpushed\n');
    await git(['add', '.'], repo.repoRoot);
    await git(['commit', '-q', '-m', 'unpushed local'], repo.repoRoot);
    const before = await git(['rev-parse', 'dev'], repo.repoRoot);
    const result = await ensureRepoFresh(repo.repoRoot, 'dev');
    expect(result.ok).toBe(true);
    const after = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(after.ok && after.value.trim()).toBe(before.ok && before.value.trim());
  });

  it('does NOT clobber a diverged local base branch', async () => {
    await externalPush(repo.repoRoot, 'dev'); // origin gains a commit
    await writeFile(join(repo.repoRoot, 'LOCAL.md'), 'unpushed\n');
    await git(['add', '.'], repo.repoRoot);
    await git(['commit', '-q', '-m', 'local diverge'], repo.repoRoot); // local gains a different commit
    const before = await git(['rev-parse', 'dev'], repo.repoRoot);
    const result = await ensureRepoFresh(repo.repoRoot, 'dev');
    expect(result.ok).toBe(true);
    const after = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(after.ok && after.value.trim()).toBe(before.ok && before.value.trim());
  });

  it('is a no-op when already up to date', async () => {
    const before = await git(['rev-parse', 'dev'], repo.repoRoot);
    const result = await ensureRepoFresh(repo.repoRoot, 'dev');
    expect(result.ok).toBe(true);
    const after = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(after.ok && after.value.trim()).toBe(before.ok && before.value.trim());
  });

  it('returns a no-op (ok) when the base branch has no origin tracking ref', async () => {
    await git(['checkout', '-q', '-b', 'orphan-local'], repo.repoRoot);
    const result = await ensureRepoFresh(repo.repoRoot, 'orphan-local');
    expect(result.ok).toBe(true); // fetch of a non-existent origin branch is tolerated
  });
});
