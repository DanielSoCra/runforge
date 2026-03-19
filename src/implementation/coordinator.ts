import { ok, err, type Result } from '../lib/result.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest, SessionResult } from '../types.js';
import { createWorktree, removeWorktree, mergeWorktree, getWorktreeDiffSize } from './worktree.js';
import { git } from '../lib/git.js';

export interface ImplementResult {
  success: boolean;
  unitResults: Array<{ unitId: string; exitStatus: string; cost: number }>;
  totalCost: number;
  error?: string;
}

export class ImplementationCoordinator {
  constructor(
    private runtime: SessionRuntime,
    private repoRoot: string,
    private maxDiffLines: number = 300,
  ) {}

  /**
   * Implement a work request as a single unit (MVP — no decomposition).
   * Creates a worktree, spawns a worker session, merges the result.
   */
  async implement(
    request: WorkRequest,
    featureBranch: string,
  ): Promise<Result<ImplementResult>> {
    const unitId = `issue-${request.issueNumber}`;

    // 1. Create worktree from feature branch
    const worktreeResult = await createWorktree(unitId, featureBranch, this.repoRoot);
    if (!worktreeResult.ok) {
      return err(new Error(`Failed to create worktree: ${worktreeResult.error.message}`));
    }
    const workspacePath = worktreeResult.value;

    try {
      // 2. Spawn worker session
      const sessionResult = await this.runtime.spawnSession(
        'worker',
        {
          variables: {
            task: `Implement the following work request:\n\nTitle: ${request.title}\n\n${request.body}`,
            specs: request.specRefs.join(', '),
          },
          workspacePath,
          baseBranch: featureBranch,
        },
        request.issueNumber,
      );

      if (!sessionResult.ok) {
        return err(new Error(`Worker session failed: ${sessionResult.error.message}`));
      }

      const result: SessionResult = sessionResult.value;
      const unitResult = {
        unitId,
        exitStatus: result.exitStatus,
        cost: result.cost,
      };

      // 3. Check exit status
      if (result.exitStatus === 'blocked' || result.exitStatus === 'needs-context') {
        return ok({
          success: false,
          unitResults: [unitResult],
          totalCost: result.cost,
          error: `Worker exited with ${result.exitStatus}: ${result.output}`,
        });
      }

      if (result.exitStatus === 'failed' || result.exitStatus === 'timed-out') {
        return ok({
          success: false,
          unitResults: [unitResult],
          totalCost: result.cost,
          error: `Worker ${result.exitStatus}`,
        });
      }

      // 4. Check diff size
      const diffSize = await getWorktreeDiffSize(unitId, featureBranch, this.repoRoot);
      if (diffSize.ok && diffSize.value > this.maxDiffLines) {
        return ok({
          success: false,
          unitResults: [unitResult],
          totalCost: result.cost,
          error: `Diff size ${diffSize.value} lines exceeds threshold of ${this.maxDiffLines}`,
        });
      }

      // 5. Merge into feature branch — must checkout feature branch first
      await git(['checkout', featureBranch], this.repoRoot);
      const mergeResult = await mergeWorktree(unitId, featureBranch, this.repoRoot);
      if (!mergeResult.ok) {
        return ok({
          success: false,
          unitResults: [unitResult],
          totalCost: result.cost,
          error: `Merge failed: ${mergeResult.error.message}`,
        });
      }

      return ok({
        success: true,
        unitResults: [unitResult],
        totalCost: result.cost,
      });
    } finally {
      // 6. Always clean up worktree
      await removeWorktree(unitId, this.repoRoot).catch(() => {});
    }
  }
}
