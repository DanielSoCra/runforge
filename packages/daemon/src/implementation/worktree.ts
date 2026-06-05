import { rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';
import { join, isAbsolute } from 'path';
import { isValidUnitId } from './task-graph.js';

const WORKTREE_DIR = 'workspaces';

const BUILD_ARTIFACT_EXCLUDES = [
  'node_modules/',
  '.pnpm-store/',
  'workspaces/',
  'dist/',
  'build/',
  '.next/',
  '.turbo/',
  'coverage/',
];

/**
 * Seed the repo's SHARED git excludes (the common git dir's info/exclude) so build
 * artifacts — node_modules, the pnpm store, the daemon's own `workspaces/` dir, and
 * common build output — are never staged by the implement auto-commit, counted
 * toward the diff-size limit, or left as untracked clutter that trips the merge.
 * Applies to repoRoot AND every worktree (they share the common git dir). Written
 * to info/exclude so the target repo's own tracked files are never modified.
 * Idempotent.
 */
export async function ensureBuildArtifactExcludes(repoRoot: string): Promise<void> {
  const commonDirResult = await git(['rev-parse', '--git-common-dir'], repoRoot);
  if (!commonDirResult.ok) return;
  const raw = commonDirResult.value.trim();
  if (!raw) return;
  const commonDir = isAbsolute(raw) ? raw : join(repoRoot, raw);
  const infoDir = join(commonDir, 'info');
  const excludePath = join(infoDir, 'exclude');
  let current = '';
  try {
    current = readFileSync(excludePath, 'utf8');
  } catch {
    /* no exclude file yet */
  }
  const present = new Set(current.split('\n').map((l) => l.trim()));
  const missing = BUILD_ARTIFACT_EXCLUDES.filter((p) => !present.has(p));
  if (missing.length === 0) return;
  if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(
    excludePath,
    `${current}${prefix}# auto-claude: build artifacts (never deliverables)\n${missing.join('\n')}\n`,
  );
}

export async function createWorktree(
  unitId: string,
  baseBranch: string,
  repoRoot?: string,
): Promise<Result<string>> {
  if (!isValidUnitId(unitId)) {
    return err(new Error(`Invalid unit ID: ${unitId}`));
  }

  const worktreePath = join(repoRoot ?? process.cwd(), WORKTREE_DIR, unitId);
  const branchName = `unit/${unitId}`;

  // Clean up stale branch/worktree from previous run if it exists.
  // git worktree remove only works for registered worktrees — if the directory
  // exists but isn't registered (e.g. leftover from a spec phase), also delete it.
  await git(['worktree', 'remove', worktreePath, '--force'], repoRoot).catch(() => {});
  if (existsSync(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true });
  }
  await git(['branch', '-D', branchName], repoRoot).catch(() => {});

  const result = await git(
    ['worktree', 'add', worktreePath, '-b', branchName, baseBranch],
    repoRoot,
  );

  if (!result.ok) return result;
  // Make build artifacts invisible to git before the worker runs, so the implement
  // auto-commit / diff-size / merge never trip over node_modules, the pnpm store, or
  // the daemon's own worktrees dir (the sandbox repo usually has no .gitignore).
  await ensureBuildArtifactExcludes(repoRoot ?? process.cwd());
  return ok(worktreePath);
}

export async function removeWorktree(
  unitId: string,
  repoRoot?: string,
): Promise<Result<void>> {
  if (!isValidUnitId(unitId)) {
    return err(new Error(`Invalid unit ID: ${unitId}`));
  }

  const worktreePath = join(repoRoot ?? process.cwd(), WORKTREE_DIR, unitId);

  // Remove the worktree (--force handles dirty state)
  const removeResult = await git(['worktree', 'remove', worktreePath, '--force'], repoRoot);

  // Delete the branch
  const branchName = `unit/${unitId}`;
  const branchResult = await git(['branch', '-D', branchName], repoRoot);

  if (!removeResult.ok) return err(removeResult.error);
  if (!branchResult.ok) return err(branchResult.error);
  return ok(undefined);
}

/** Delete a unit branch without touching the worktree (already removed by batch.ts finally block). */
export async function deleteUnitBranch(
  unitId: string,
  repoRoot?: string,
): Promise<Result<void>> {
  if (!isValidUnitId(unitId)) {
    return err(new Error(`Invalid unit ID: ${unitId}`));
  }

  const branchName = `unit/${unitId}`;
  const result = await git(['branch', '-D', branchName], repoRoot);
  if (!result.ok) return err(result.error);
  return ok(undefined);
}

export async function listWorktrees(repoRoot?: string): Promise<Result<string[]>> {
  const result = await git(['worktree', 'list', '--porcelain'], repoRoot);
  if (!result.ok) return result as Result<string[], Error>;

  const paths = result.value
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.replace('worktree ', ''));

  return ok(paths);
}

export async function getWorktreeDiffSize(
  unitId: string,
  baseBranch: string,
  repoRoot?: string,
): Promise<Result<number>> {
  if (!isValidUnitId(unitId)) {
    return err(new Error(`Invalid unit ID: ${unitId}`));
  }

  const branchName = `unit/${unitId}`;
  const result = await git(['diff', '--stat', `${baseBranch}...${branchName}`], repoRoot);
  if (!result.ok) {
    // Empty diff (no changes) is expected — but git errors should propagate
    if (result.error.message.includes('unknown revision')) return ok(0);
    return err(result.error);
  }

  return ok(parseDiffStatSize(result.value));
}

export async function getBranchDiffSize(
  baseBranch: string,
  targetBranch: string,
  repoRoot?: string,
): Promise<Result<number>> {
  const result = await git(['diff', '--stat', `${baseBranch}...${targetBranch}`], repoRoot);
  if (!result.ok) return err(result.error);
  return ok(parseDiffStatSize(result.value));
}

function parseDiffStatSize(diffStat: string): number {
  // Parse last line: " X files changed, Y insertions(+), Z deletions(-)"
  const lines = diffStat.split('\n').filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? '';
  const insertions = lastLine.match(/(\d+) insertion/);
  const deletions = lastLine.match(/(\d+) deletion/);
  return (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0);
}

export async function mergeWorktree(
  unitId: string,
  targetBranch: string,
  repoRoot?: string,
): Promise<Result<void>> {
  if (!isValidUnitId(unitId)) {
    return err(new Error(`Invalid unit ID: ${unitId}`));
  }

  const branchName = `unit/${unitId}`;
  const result = await git(
    ['merge', '--no-ff', branchName, '-m', `merge: unit ${unitId}`],
    repoRoot,
  );
  if (!result.ok) return err(result.error);
  return ok(undefined);
}
