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

  if (!existsSync(workspaceDir)) {
    const created = await createFresh(repoRoot, workspaceDir, featureBranch, sourceRef);
    if (!created.ok) return created;
  }

  // Retry-after-base-advance (#847): a stuck run retried after the base moved
  // reuses the existing `feature/<N>` branch, whose worktree then carries STALE
  // base file contents — the review gate reads those and escalates on phantom
  // governance "regressions". Rebase the branch's own delta onto the current
  // base; fail closed (park → stuck) rather than proceed on a drifted base.
  const refreshed = await refreshBranchBase(
    repoRoot,
    workspaceDir,
    featureBranch,
    sourceRef,
  );
  if (!refreshed.ok) return refreshed;

  return ok({ path: workspaceDir });
}

/**
 * If `baseRef` (e.g. `origin/main`) has advanced past the merge-base of
 * `featureBranch`, rebase the branch's own commits onto the current base so
 * the worktree no longer carries stale base file contents (#847).
 *
 * - Branch already based on the current base → no-op.
 * - Unusable worktree / unresolvable refs → no-op (Plan B "accept as-is"
 *   semantics preserved; deeper repair belongs to the recreate-workspace path).
 * - Base advanced, branch has no own commits → fast-forward to the base
 *   (rebase with nothing to replay), equivalent to recreating the branch.
 * - Base advanced, branch has committed delta → rebase preserves the delta.
 * - Dirty worktree or rebase conflict → fail CLOSED: abort the rebase (branch
 *   left at its pre-rebase tip) and return an error so the run parks instead
 *   of reviewing against a stale base.
 */
async function refreshBranchBase(
  repoRoot: string,
  workspaceDir: string,
  featureBranch: string,
  baseRef: string,
): Promise<Result<void>> {
  // Plan B scope: an existing-but-broken workspace dir is accepted as-is by
  // reconcileWorkspace; base refresh must not introduce a new failure mode there.
  if (!(await isUsableWorktree(workspaceDir))) return ok(undefined);

  const baseSha = await git(
    ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
    repoRoot,
  );
  if (!baseSha.ok || !baseSha.value.trim()) return ok(undefined);
  const base = baseSha.value.trim();

  const branchSha = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${featureBranch}`],
    repoRoot,
  );
  if (!branchSha.ok || !branchSha.value.trim()) return ok(undefined);
  const branch = branchSha.value.trim();

  const mergeBase = await git(['merge-base', branch, base], repoRoot);
  if (!mergeBase.ok) return ok(undefined); // unrelated histories → leave intact
  if (mergeBase.value.trim() === base) return ok(undefined); // base not advanced

  // The base advanced past the branch's merge-base. Refuse to touch a dirty
  // worktree: uncommitted state from the failed attempt cannot be carried
  // through a rebase safely.
  const status = await git(['status', '--porcelain=v1'], workspaceDir);
  if (!status.ok) {
    return err(new Error(
      `reconcileWorkspace: base ${baseRef} advanced past ${featureBranch}'s merge-base but worktree status failed: ${status.error.message}`,
    ));
  }
  if (status.value.trim() !== '') {
    return err(new Error(
      `reconcileWorkspace: base ${baseRef} advanced past ${featureBranch}'s merge-base but the worktree has uncommitted changes — refusing to rebase (fail closed, #847)`,
    ));
  }

  // The rebase mutates whatever HEAD the worktree has checked out — verify it
  // is actually the feature branch before rewriting anything.
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspaceDir);
  if (!head.ok || head.value.trim() !== featureBranch) {
    return err(new Error(
      `reconcileWorkspace: base ${baseRef} advanced but worktree HEAD is '${head.ok ? head.value.trim() : 'detached/unknown'}' (expected ${featureBranch}) — refusing to rebase (fail closed, #847)`,
    ));
  }

  const rebased = await git(['rebase', base], workspaceDir);
  if (!rebased.ok) {
    // Leave the branch at its original tip (delta preserved) and fail closed.
    await git(['rebase', '--abort'], workspaceDir);
    return err(new Error(
      `reconcileWorkspace: rebasing ${featureBranch} onto ${baseRef} conflicted — aborted, failing closed (#847): ${rebased.error.message}`,
    ));
  }
  console.log(
    `[reconcileWorkspace] rebased ${featureBranch} onto advanced base ${baseRef} (${base.slice(0, 12)})`,
  );
  return ok(undefined);
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
  baseRef: string,
): Promise<Result<void>> {
  // The configured base may be a remote-tracking ref ("origin/main", the usual
  // runtimeSource.expectedRef shape), a plain branch name ("main"), or a fully
  // qualified ref ("refs/heads/main" / "refs/remotes/origin/main" — config and
  // runtime validation accept any resolvable ref). Derive the bare branch name
  // for the fetch ref-spec: `git fetch origin origin/main` is malformed — the
  // remote has no ref named "origin/main" — and silently left the base stale
  // on every run (#847); the fully-qualified forms have the same silent-no-op
  // failure mode.
  const baseBranch = ['refs/remotes/origin/', 'refs/heads/', 'origin/'].reduce(
    (ref, prefix) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref),
    baseRef,
  );
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
