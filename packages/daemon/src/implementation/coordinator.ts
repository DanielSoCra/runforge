import { ok, err, type Result } from '../lib/result.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest, TaskGraph, Gotcha, PipelineVariant } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import type { GotchaStore } from '../knowledge/gotcha-store.js';
import { createSingleUnitGraph, getUnitsByBatch } from './task-graph.js';
import { executeBatch, type UnitResult } from './batch.js';
import { deleteUnitBranch } from './worktree.js';
import { mergeUnitsSequentially } from './merge.js';
import { isMergeable } from './exit-status.js';
import { decompose } from './decompose.js';
import { git } from '../lib/git.js';

export interface ImplementResult {
  success: boolean;
  unitResults: UnitResult[];
  totalCost: number;
  batchesCompleted: number;
  error?: string;
  handoffNotes?: Map<string, string>;
  containmentBreach?: boolean;
}

export class ImplementationCoordinator {
  constructor(
    private runtime: SessionRuntime,
    private repoRoot: string,
    private maxDiffLines: number = 300,
    private staggerMs: number = 2000,
    private gotchaStore?: GotchaStore,
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
    options?: { complexity?: 'simple' | 'standard' | 'complex'; specContent?: string; checkpoint?: number; handoffNotes?: Map<string, string>; variant?: PipelineVariant; diagnosisDetail?: string },
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

      // Match gotchas for each unit's expected artifacts (ARCH-AC-KNOWLEDGE: Gotcha injection flow)
      const unitPitfalls = new Map<string, string>();
      if (this.gotchaStore) {
        for (const unit of batch) {
          if (unit.expectedArtifacts.length > 0) {
            try {
              const matched = await this.gotchaStore.match(unit.expectedArtifacts);
              if (matched.length > 0) {
                unitPitfalls.set(unit.id, formatGotchas(matched));
              }
            } catch (e) {
              console.warn(`[coordinator] Failed to match gotchas for ${unit.id}:`, e);
            }
          }
        }
      }

      // Execute batch concurrently (pass handoff notes from prior attempts — ARCH-AC-HANDOFF step 7)
      const batchResult = await executeBatch(
        batch,
        featureBranch,
        request.issueNumber,
        this.runtime,
        this.repoRoot,
        { staggerMs: this.staggerMs, maxDiffLines: this.maxDiffLines },
        runWriter,
        runId,
        unitPitfalls,
        this.gotchaStore,
        options?.handoffNotes,
        options?.variant,
        options?.variant === 'bug' ? { bugReport: request.body, diagnosis: options?.diagnosisDetail ?? '' } : undefined,
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

      // Check for containment breach — terminal, no retries (STACK-AC-OPERATIONAL-SAFETY)
      const breached = batchResult.results.some((r) => r.containmentBreach);

      if (blocked.length > 0) {
        // Clean up all branches in this batch before returning (#133)
        for (const r of batchResult.results) {
          await deleteUnitBranch(r.unitId, this.repoRoot).catch(() => {});
        }
        return ok({
          success: false,
          unitResults: allResults,
          totalCost,
          batchesCompleted: i,
          error: `Units blocked: ${blocked.map((r) => r.unitId).join(', ')}`,
          handoffNotes: collectHandoffNotes(allResults),
          containmentBreach: breached || undefined,
        });
      }

      if (failures.length === batch.length) {
        // Clean up all branches in this batch before returning (#133)
        for (const r of batchResult.results) {
          await deleteUnitBranch(r.unitId, this.repoRoot).catch(() => {});
        }
        return ok({
          success: false,
          unitResults: allResults,
          totalCost,
          batchesCompleted: i,
          error: `All units in batch ${i} failed`,
          handoffNotes: collectHandoffNotes(allResults),
          containmentBreach: breached || undefined,
        });
      }

      // 3. Merge successful units sequentially into feature branch (STACK-AC-IMPLEMENTATION: merge.ts)
      await git(['checkout', featureBranch], this.repoRoot);
      const successfulUnits = batchResult.results.filter((r) => isMergeable(r.exitStatus));
      const nonMergedUnits = batchResult.results.filter((r) => !isMergeable(r.exitStatus));

      const mergeResult = await mergeUnitsSequentially(
        successfulUnits.map((r) => r.unitId),
        featureBranch,
        this.repoRoot,
        nonMergedUnits.map((r) => r.unitId),
      );
      if (!mergeResult.ok) {
        return ok({
          success: false,
          unitResults: allResults,
          totalCost,
          batchesCompleted: i,
          error: mergeResult.error.message,
          handoffNotes: collectHandoffNotes(allResults),
          containmentBreach: breached || undefined,
        });
      }

      // Clear stale handoffs for successful units (STACK-AC-HANDOFF-COORDINATOR: clear after success)
      if (options?.handoffNotes) {
        for (const unitResult of successfulUnits) {
          options.handoffNotes.delete(unitResult.unitId);
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

/** Collect handoff notes from unit results for use in retry attempts (ARCH-AC-HANDOFF step 6). */
function collectHandoffNotes(results: UnitResult[]): Map<string, string> | undefined {
  const notes = new Map<string, string>();
  for (const r of results) {
    if (r.handoffNote) {
      notes.set(r.unitId, r.handoffNote);
    }
  }
  return notes.size > 0 ? notes : undefined;
}

function formatGotchas(gotchas: Gotcha[]): string {
  return gotchas
    .map((g) => `- [${g.priorityTier === 'elevated' ? 'IMPORTANT' : 'note'}] ${g.description} (patterns: ${g.artifactPatterns.join(', ')})`)
    .join('\n');
}
