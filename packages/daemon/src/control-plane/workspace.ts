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
  if (existsSync(workspaceDir)) return ok({ path: workspaceDir });

  const wtExisting = await git(
    ['worktree', 'add', workspaceDir, featureBranch],
    repoRoot,
  );
  if (wtExisting.ok) return ok({ path: workspaceDir });
  if (existsSync(workspaceDir)) return ok({ path: workspaceDir });

  // Orphan recovery: stale worktree registration may point at a deleted path.
  await git(['worktree', 'prune'], repoRoot);
  const wtRetry = await git(
    ['worktree', 'add', workspaceDir, featureBranch],
    repoRoot,
  );
  if (wtRetry.ok) return ok({ path: workspaceDir });
  if (existsSync(workspaceDir)) return ok({ path: workspaceDir });

  return err(new Error(
    `reconcileWorkspace: failed to create worktree at ${workspaceDir} for ${featureBranch}: ${wtRetry.error.message}`,
  ));
}
