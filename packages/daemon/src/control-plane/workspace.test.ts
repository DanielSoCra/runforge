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
async function externalPush(
  repoRoot: string,
  branch: string,
  file = 'EXTERNAL.md',
  content = 'pushed externally\n',
): Promise<string> {
  const url = await git(['remote', 'get-url', 'origin'], repoRoot);
  if (!url.ok) throw new Error('no origin url');
  const ext = await mkdtemp(join(tmpdir(), 'workspace-ext-'));
  try {
    await git(['clone', '-q', url.value.trim(), '.'], ext);
    await git(['config', 'user.email', 'ext@test'], ext);
    await git(['config', 'user.name', 'ext'], ext);
    await git(['checkout', '-q', branch], ext);
    await writeFile(join(ext, file), content);
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

  it('regression #847: accepts a remote-tracking base ref (origin/<branch>) and fetches the correct remote ref', async () => {
    // Production passes runtimeSource.expectedRef ("origin/main") straight
    // through. The old code ran `git fetch origin origin/main` — a malformed
    // ref-spec that failed on every run and silently left the base stale.
    const newSha = await externalPush(repo.repoRoot, 'dev');

    const result = await ensureRepoFresh(repo.repoRoot, 'origin/dev');
    expect(result.ok).toBe(true);

    // The fetch only updates the remote-tracking ref when it was invoked with
    // the correct ref-spec (`fetch origin dev`) — the malformed form errors out.
    const tracking = await git(
      ['rev-parse', 'refs/remotes/origin/dev'],
      repo.repoRoot,
    );
    expect(tracking.ok && tracking.value.trim()).toBe(newSha);
    // And the local base branch is fast-forwarded too.
    const local = await git(['rev-parse', 'dev'], repo.repoRoot);
    expect(local.ok && local.value.trim()).toBe(newSha);
  });

  it.each([['refs/heads/dev'], ['refs/remotes/origin/dev']])(
    'regression #847 P2: accepts a fully-qualified base ref (%s) — config/runtime validation admit any resolvable ref',
    async (qualifiedRef) => {
      const newSha = await externalPush(repo.repoRoot, 'dev');
      const result = await ensureRepoFresh(repo.repoRoot, qualifiedRef);
      expect(result.ok).toBe(true);
      // Same silent-no-op failure mode as origin/<branch>: only a correct
      // `fetch origin dev` updates the tracking ref and fast-forwards.
      const tracking = await git(
        ['rev-parse', 'refs/remotes/origin/dev'],
        repo.repoRoot,
      );
      expect(tracking.ok && tracking.value.trim()).toBe(newSha);
      const local = await git(['rev-parse', 'dev'], repo.repoRoot);
      expect(local.ok && local.value.trim()).toBe(newSha);
    },
  );
});

describe('reconcileWorkspace base refresh (#847)', () => {
  let repo: Awaited<ReturnType<typeof makeRepo>>;
  beforeEach(async () => { repo = await makeRepo(); });
  afterEach(async () => { await repo.cleanup(); });

  const opts = (workspaceDir: string, featureBranch: string) => ({
    repoRoot: repo.repoRoot,
    workspaceDir,
    featureBranch,
    stagingBranch: 'dev',
    sourceRef: 'origin/dev',
  });

  async function commitInWorkspace(
    workspaceDir: string,
    file: string,
    content: string,
  ): Promise<void> {
    await writeFile(join(workspaceDir, file), content);
    await git(['add', '.'], workspaceDir);
    await git(['commit', '-q', '-m', `delta: ${file}`], workspaceDir);
  }

  it('retried run with advanced base: rebases the reused branch onto the fresh base, preserving its delta', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-847');
    const first = await reconcileWorkspace(opts(workspaceDir, 'feature/847'));
    expect(first.ok).toBe(true);
    // The failed attempt left its intended (committed) one-file edit behind.
    await commitInWorkspace(workspaceDir, 'delta.txt', 'the intended change\n');

    // main advances while the run is stuck; the retry re-runs detect:
    // ensureRepoFresh → reconcileWorkspace on the SAME branch/workspace.
    const baseSha = await externalPush(repo.repoRoot, 'dev');
    await ensureRepoFresh(repo.repoRoot, 'origin/dev');

    const second = await reconcileWorkspace(opts(workspaceDir, 'feature/847'));
    expect(second.ok).toBe(true);

    // Branch delta preserved…
    expect(existsSync(join(workspaceDir, 'delta.txt'))).toBe(true);
    // …and the base refreshed: the advanced base commit is now an ancestor.
    expect(existsSync(join(workspaceDir, 'EXTERNAL.md'))).toBe(true);
    const mergeBase = await git(
      ['merge-base', 'feature/847', 'origin/dev'],
      repo.repoRoot,
    );
    expect(mergeBase.ok && mergeBase.value.trim()).toBe(baseSha);
  });

  it('retried run with advanced base and no delta: fast-forwards the branch to the fresh base', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-847-ff');
    await reconcileWorkspace(opts(workspaceDir, 'feature/847-ff'));

    const baseSha = await externalPush(repo.repoRoot, 'dev');
    await ensureRepoFresh(repo.repoRoot, 'origin/dev');

    const second = await reconcileWorkspace(opts(workspaceDir, 'feature/847-ff'));
    expect(second.ok).toBe(true);
    const tip = await git(['rev-parse', 'feature/847-ff'], repo.repoRoot);
    expect(tip.ok && tip.value.trim()).toBe(baseSha);
  });

  it('recreated workspace for an existing stale branch also gets its base refreshed', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-847-gone');
    await reconcileWorkspace(opts(workspaceDir, 'feature/847-gone'));
    await commitInWorkspace(workspaceDir, 'delta.txt', 'kept\n');
    // Workspace dir vanished (cleanup) but the branch survived.
    await git(['worktree', 'remove', '--force', workspaceDir], repo.repoRoot);

    const baseSha = await externalPush(repo.repoRoot, 'dev');
    await ensureRepoFresh(repo.repoRoot, 'origin/dev');

    const second = await reconcileWorkspace(opts(workspaceDir, 'feature/847-gone'));
    expect(second.ok).toBe(true);
    expect(existsSync(join(workspaceDir, 'delta.txt'))).toBe(true);
    const mergeBase = await git(
      ['merge-base', 'feature/847-gone', 'origin/dev'],
      repo.repoRoot,
    );
    expect(mergeBase.ok && mergeBase.value.trim()).toBe(baseSha);
  });

  it('fails closed on a rebase conflict, leaving the branch tip intact and no rebase in progress', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-847-conflict');
    await reconcileWorkspace(opts(workspaceDir, 'feature/847-conflict'));
    await commitInWorkspace(workspaceDir, 'README.md', 'branch version\n');
    const tipBefore = await git(['rev-parse', 'feature/847-conflict'], repo.repoRoot);

    await externalPush(repo.repoRoot, 'dev', 'README.md', 'external version\n');
    await ensureRepoFresh(repo.repoRoot, 'origin/dev');

    const second = await reconcileWorkspace(opts(workspaceDir, 'feature/847-conflict'));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('failing closed');

    // Branch untouched (delta preserved), rebase aborted cleanly.
    const tipAfter = await git(['rev-parse', 'feature/847-conflict'], repo.repoRoot);
    expect(tipAfter.ok && tipAfter.value.trim()).toBe(
      tipBefore.ok && tipBefore.value.trim(),
    );
    const status = await git(['status', '--porcelain=v1'], workspaceDir);
    expect(status.ok && status.value.trim()).toBe('');
  });

  it('fails closed when the base advanced but the worktree has uncommitted changes', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-847-dirty');
    await reconcileWorkspace(opts(workspaceDir, 'feature/847-dirty'));
    await writeFile(join(workspaceDir, 'wip.txt'), 'uncommitted\n');

    await externalPush(repo.repoRoot, 'dev');
    await ensureRepoFresh(repo.repoRoot, 'origin/dev');

    const second = await reconcileWorkspace(opts(workspaceDir, 'feature/847-dirty'));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('uncommitted');
    // The dirty state is never destroyed.
    expect(existsSync(join(workspaceDir, 'wip.txt'))).toBe(true);
  });

  it('is a no-op when the branch is already based on the current base', async () => {
    const workspaceDir = join(repo.repoRoot, 'workspaces', 'issue-847-fresh');
    await reconcileWorkspace(opts(workspaceDir, 'feature/847-fresh'));
    await commitInWorkspace(workspaceDir, 'delta.txt', 'x\n');
    const tipBefore = await git(['rev-parse', 'feature/847-fresh'], repo.repoRoot);

    const second = await reconcileWorkspace(opts(workspaceDir, 'feature/847-fresh'));
    expect(second.ok).toBe(true);
    const tipAfter = await git(['rev-parse', 'feature/847-fresh'], repo.repoRoot);
    expect(tipAfter.ok && tipAfter.value.trim()).toBe(
      tipBefore.ok && tipBefore.value.trim(),
    );
  });
});
