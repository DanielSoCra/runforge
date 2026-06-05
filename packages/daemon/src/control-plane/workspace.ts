// packages/daemon/src/control-plane/workspace.ts
import { existsSync } from 'node:fs';
import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';

export interface ReconcileOptions {
  repoRoot: string;
  workspaceDir: string;
  featureBranch: string;
  stagingBranch: string;
  sourceRef?: string;
}

export interface ReconcileSuccess {
  path: string;
}

/**
 * Bring a workspace to a usable state for the detect phase.
 *
 * Scope (issue #489 Plan B):
 *   - If workspace dir does not exist → create worktree off staging (or off
 *     existing local branch if the branch already exists).
 *   - If workspace dir exists → accept as-is. Deeper validation (HEAD,
 *     cleanliness, upstream, branch-vs-staging) is deferred to a follow-up
 *     plan because safe recovery requires typed failure outcomes and
 *     archive-without-data-loss semantics that this plan does not deliver.
 *   - If git's worktree registration is orphaned (dir was deleted behind
 *     git's back) → prune and retry once.
 *
 * Idempotent: safe to call repeatedly. Replaces the `git pull --ff-only`
 * fallback in detect that failed for branches without upstream tracking
 * (the #484 sticking pattern).
 */
export async function reconcileWorkspace(
  opts: ReconcileOptions,
): Promise<Result<ReconcileSuccess>> {
  const { repoRoot, workspaceDir, featureBranch, stagingBranch } = opts;
  const sourceRef = opts.sourceRef ?? stagingBranch;

  if (existsSync(workspaceDir)) {
    return ok({ path: workspaceDir });
  }
  return createFresh(repoRoot, workspaceDir, featureBranch, sourceRef);
}

/**
 * Bring the local `baseBranch` in `repoRoot` up to date with `origin/baseBranch`
 * before a run reconciles its workspace, so worktrees branch off the latest
 * remote main instead of a stale local clone. (The daemon otherwise only fetches
 * when IT merges, leaving externally-pushed specs invisible until a manual
 * `git fetch origin main && git reset --hard origin/main`.)
 *
 * Fast-forward ONLY: if local `baseBranch` has diverged from or is ahead of
 * origin (e.g. an un-pushed daemon commit), it is left untouched — never
 * clobbered. A missing local branch or origin tracking ref (e.g. a tag/commit
 * sourceRef) is a safe no-op. Idempotent.
 */
export async function ensureRepoFresh(
  repoRoot: string,
  baseBranch: string,
): Promise<Result<void>> {
  // Best-effort freshness: a fetch failure (ref absent on origin, transient
  // network/auth) must NOT introduce a new failure mode — degrade to the prior
  // behaviour (branch off the existing local base) rather than failing the run.
  const fetched = await git(['fetch', 'origin', baseBranch], repoRoot);
  if (!fetched.ok) {
    console.warn(
      `[ensureRepoFresh] fetch origin ${baseBranch} failed (using local base as-is): ${fetched.error.message}`,
    );
    return ok(undefined);
  }

  const localSha = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`],
    repoRoot,
  );
  const remoteSha = await git(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`],
    repoRoot,
  );
  // Missing local branch or no origin tracking ref → nothing to fast-forward.
  if (!localSha.ok || !remoteSha.ok || !localSha.value.trim() || !remoteSha.value.trim()) {
    return ok(undefined);
  }
  if (localSha.value.trim() === remoteSha.value.trim()) {
    return ok(undefined); // already up to date
  }

  // Advance only when local is strictly behind: its tip must be an ancestor of
  // the remote tip. Diverged or ahead → leave local intact (never clobber).
  const isAncestor = await git(
    ['merge-base', '--is-ancestor', `refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`],
    repoRoot,
  );
  if (!isAncestor.ok) {
    return ok(undefined);
  }

  // Fast-forward. If baseBranch is checked out, merge --ff-only also updates the
  // working tree; otherwise move the branch ref directly (no checkout needed).
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot);
  if (head.ok && head.value.trim() === baseBranch) {
    const ff = await git(['merge', '--ff-only', `origin/${baseBranch}`], repoRoot);
    if (!ff.ok) {
      return err(new Error(`ensureRepoFresh: ff-merge ${baseBranch} failed: ${ff.error.message}`));
    }
  } else {
    const upd = await git(
      ['update-ref', `refs/heads/${baseBranch}`, remoteSha.value.trim()],
      repoRoot,
    );
    if (!upd.ok) {
      return err(new Error(`ensureRepoFresh: update-ref ${baseBranch} failed: ${upd.error.message}`));
    }
  }
  return ok(undefined);
}

async function createFresh(
  repoRoot: string,
  workspaceDir: string,
  featureBranch: string,
  sourceRef: string,
): Promise<Result<ReconcileSuccess>> {
  const wtNew = await git(
    ['worktree', 'add', workspaceDir, '-b', featureBranch, sourceRef],
    repoRoot,
  );
  if (wtNew.ok) return ok({ path: workspaceDir });
  if (await isUsableWorktree(workspaceDir)) return ok({ path: workspaceDir });

  const wtExisting = await git(
    ['worktree', 'add', workspaceDir, featureBranch],
    repoRoot,
  );
  if (wtExisting.ok) return ok({ path: workspaceDir });
  if (await isUsableWorktree(workspaceDir)) return ok({ path: workspaceDir });

  // Orphan recovery: stale worktree registration may point at a deleted path.
  // After prune, retry the full create sequence — the new-branch attempt may
  // succeed if the orphan was the only thing blocking it.
  await git(['worktree', 'prune'], repoRoot);

  const wtRetryNew = await git(
    ['worktree', 'add', workspaceDir, '-b', featureBranch, sourceRef],
    repoRoot,
  );
  if (wtRetryNew.ok) return ok({ path: workspaceDir });
  if (await isUsableWorktree(workspaceDir)) return ok({ path: workspaceDir });

  const wtRetryExisting = await git(
    ['worktree', 'add', workspaceDir, featureBranch],
    repoRoot,
  );
  if (wtRetryExisting.ok) return ok({ path: workspaceDir });
  if (await isUsableWorktree(workspaceDir)) return ok({ path: workspaceDir });

  return err(new Error(
    `reconcileWorkspace: failed to create worktree at ${workspaceDir} for ${featureBranch}: ${wtRetryExisting.error.message}`,
  ));
}

/**
 * Probe that the directory exists AND is a usable git worktree. Guards against
 * the case where `git worktree add` fails after partially creating the dir —
 * `existsSync` alone would return true and mask a broken workspace.
 */
async function isUsableWorktree(workspaceDir: string): Promise<boolean> {
  if (!existsSync(workspaceDir)) return false;
  const probe = await git(['rev-parse', '--git-dir'], workspaceDir);
  return probe.ok;
}
