import { ok, err, type Result } from '../lib/result.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest, TaskGraph } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { createSingleUnitGraph, getUnitsByBatch } from './task-graph.js';
import { executeBatch, type UnitResult } from './batch.js';
import { mergeWorktree } from './worktree.js';
import { decompose } from './decompose.js';
import { git } from '../lib/git.js';

export interface ImplementResult {
  success: boolean;
  unitResults: UnitResult[];
  totalCost: number;
  batchesCompleted: number;
  error?: string;
}

export class ImplementationCoordinator {
  constructor(
    private runtime: SessionRuntime,
    private repoRoot: string,
    private maxDiffLines: number = 300,
    private staggerMs: number = 2000,
  ) {}

  /**
   * Implement a work request. For simple requests, runs a single unit.
   * For standard/complex, decomposes into batches and runs concurrently.
   */
  async implement(
    request: WorkRequest,
    featureBranch: string,
    runWriter?: SupabaseRunWriter,
    runId?: string,
    options?: { complexity?: 'simple' | 'standard' | 'complex'; specContent?: string; checkpoint?: number },
  ): Promise<Result<ImplementResult>> {
    // 1. Get task graph
    let graph: TaskGraph;
    if (options?.complexity === 'simple' || !options?.complexity) {
      graph = createSingleUnitGraph(
        request.issueNumber,
        featureBranch,
        request.title,
        `Title: ${request.title}\n\n${request.body}`,
      );
    } else {
      const decomposeResult = await decompose(
        request,
        featureBranch,
        this.runtime,
        options.specContent ?? '',
        runWriter,
        runId,
      );
      if (!decomposeResult.ok) {
        return err(new Error(`Decomposition failed: ${decomposeResult.error.message}`));
      }
      graph = decomposeResult.value;
    }

    // 2. Execute batches
    const batches = getUnitsByBatch(graph);
    const allResults: UnitResult[] = [];
    let totalCost = 0;
    const startBatch = options?.checkpoint ?? 0;

    for (let i = startBatch; i < batches.length; i++) {
      const batch = batches[i]!;

      // Execute batch concurrently
      const batchResult = await executeBatch(
        batch,
        featureBranch,
        request.issueNumber,
        this.runtime,
        this.repoRoot,
        { staggerMs: this.staggerMs, maxDiffLines: this.maxDiffLines },
        runWriter,
        runId,
      );

      allResults.push(...batchResult.results);
      totalCost += batchResult.totalCost;

      // Check for failures
      const failures = batchResult.results.filter(
        (r) => r.exitStatus === 'failed' || r.exitStatus === 'timed-out',
      );
      const blocked = batchResult.results.filter(
        (r) => r.exitStatus === 'blocked' || r.exitStatus === 'needs-context',
      );

      if (blocked.length > 0) {
        return ok({
          success: false,
          unitResults: allResults,
          totalCost,
          batchesCompleted: i,
          error: `Units blocked: ${blocked.map((r) => r.unitId).join(', ')}`,
        });
      }

      if (failures.length === batch.length) {
        // All units in batch failed
        return ok({
          success: false,
          unitResults: allResults,
          totalCost,
          batchesCompleted: i,
          error: `All units in batch ${i} failed`,
        });
      }

      // 3. Merge successful units sequentially into feature branch
      await git(['checkout', featureBranch], this.repoRoot);
      const successfulUnits = batchResult.results.filter(
        (r) => r.exitStatus === 'completed' || r.exitStatus === 'completed-with-concerns',
      );
      for (const unitResult of successfulUnits) {
        const mergeResult = await mergeWorktree(unitResult.unitId, featureBranch, this.repoRoot);
        if (!mergeResult.ok) {
          return ok({
            success: false,
            unitResults: allResults,
            totalCost,
            batchesCompleted: i,
            error: `Merge failed for ${unitResult.unitId}: ${mergeResult.error.message}`,
          });
        }
      }
    }

    return ok({
      success: true,
      unitResults: allResults,
      totalCost,
      batchesCompleted: batches.length,
    });
  }
}
