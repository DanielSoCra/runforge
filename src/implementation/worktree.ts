import { git } from '../lib/git.js';
import { ok, err, type Result } from '../lib/result.js';
import { join } from 'path';

const WORKTREE_DIR = 'workspaces';

export async function createWorktree(
  unitId: string,
  baseBranch: string,
  repoRoot?: string,
): Promise<Result<string>> {
  const worktreePath = join(repoRoot ?? process.cwd(), WORKTREE_DIR, unitId);
  const branchName = `unit/${unitId}`;

  // Clean up stale branch/worktree from previous run if it exists
  await git(['worktree', 'remove', worktreePath, '--force'], repoRoot).catch(() => {});
  await git(['branch', '-D', branchName], repoRoot).catch(() => {});

  const result = await git(
    ['worktree', 'add', worktreePath, '-b', branchName, baseBranch],
    repoRoot,
  );

  if (!result.ok) return result;
  return ok(worktreePath);
}

export async function removeWorktree(
  unitId: string,
  repoRoot?: string,
): Promise<Result<void>> {
  const worktreePath = join(repoRoot ?? process.cwd(), WORKTREE_DIR, unitId);

  // Remove the worktree (--force handles dirty state)
  const removeResult = await git(['worktree', 'remove', worktreePath, '--force'], repoRoot);

  // Delete the branch
  const branchName = `unit/${unitId}`;
  await git(['branch', '-D', branchName], repoRoot);

  if (!removeResult.ok) return err(removeResult.error);
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
  const branchName = `unit/${unitId}`;
  const result = await git(['diff', '--stat', `${baseBranch}...${branchName}`], repoRoot);
  if (!result.ok) {
    // Empty diff (no changes) is expected — but git errors should propagate
    if (result.error.message.includes('unknown revision')) return ok(0);
    return err(result.error);
  }

  // Parse last line: " X files changed, Y insertions(+), Z deletions(-)"
  const lines = result.value.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const insertions = lastLine.match(/(\d+) insertion/);
  const deletions = lastLine.match(/(\d+) deletion/);
  return ok(
    (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0),
  );
}

export async function mergeWorktree(
  unitId: string,
  targetBranch: string,
  repoRoot?: string,
): Promise<Result<void>> {
  const branchName = `unit/${unitId}`;
  const result = await git(
    ['merge', '--no-ff', branchName, '-m', `merge: unit ${unitId}`],
    repoRoot,
  );
  if (!result.ok) return err(result.error);
  return ok(undefined);
}
