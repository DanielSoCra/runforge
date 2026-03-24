// src/implementation/merge.ts
import { ok, err, type Result } from '../lib/result.js';
import { mergeWorktree, deleteUnitBranch } from './worktree.js';

/**
 * Merge completed units sequentially into the feature branch.
 * Per L3 spec: sequential merge with --no-ff (handled by mergeWorktree).
 * Cleans up unit branches after merge and for failed units.
 */
export async function mergeUnitsSequentially(
  successfulUnitIds: string[],
  featureBranch: string,
  repoRoot: string,
  failedUnitIds?: string[],
): Promise<Result<void>> {
  // Merge each successful unit sequentially
  for (let i = 0; i < successfulUnitIds.length; i++) {
    const unitId = successfulUnitIds[i]!;
    const mergeResult = await mergeWorktree(unitId, featureBranch, repoRoot);
    if (!mergeResult.ok) {
      // Clean up branches for remaining unmerged units (#385)
      for (let j = i; j < successfulUnitIds.length; j++) {
        await deleteUnitBranch(successfulUnitIds[j]!, repoRoot).catch(() => {});
      }
      // Also clean up failed unit branches before returning
      if (failedUnitIds) {
        for (const fid of failedUnitIds) {
          await deleteUnitBranch(fid, repoRoot).catch(() => {});
        }
      }
      return err(new Error(`Merge failed for ${unitId}: ${mergeResult.error.message}`));
    }
    // Clean up unit branch after successful merge
    await deleteUnitBranch(unitId, repoRoot).catch(() => {});
  }

  // Clean up branches for failed/non-merged units
  if (failedUnitIds) {
    for (const unitId of failedUnitIds) {
      await deleteUnitBranch(unitId, repoRoot).catch(() => {});
    }
  }

  return ok(undefined);
}
