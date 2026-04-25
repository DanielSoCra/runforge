// packages/daemon/src/control-plane/workspace.ts
import { existsSync } from 'node:fs';
import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';

export interface ReconcileOptions {
  repoRoot: string;
  workspaceDir: string;
  featureBranch: string;
  stagingBranch: string;
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

  if (existsSync(workspaceDir)) {
    return ok({ path: workspaceDir });
  }
  return createFresh(repoRoot, workspaceDir, featureBranch, stagingBranch);
}

async function createFresh(
  repoRoot: string,
  workspaceDir: string,
  featureBranch: string,
  stagingBranch: string,
): Promise<Result<ReconcileSuccess>> {
  const wtNew = await git(
    ['worktree', 'add', workspaceDir, '-b', featureBranch, stagingBranch],
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
    ['worktree', 'add', workspaceDir, '-b', featureBranch, stagingBranch],
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
