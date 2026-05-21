// src/coordination/concurrency.ts — Pool evaluation algorithm for agent spawning
import type { WorkerClaim, AgentType, Batch } from './types.js';
import { isActiveClaimStatus, isTerminalSatisfied } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpawnDecision {
  issueNumber: number;
  agentType: AgentType;
  batchItemId: string | null;
}

export interface DispatchQueueItem {
  issueNumber: number;
  repoKey?: string; // "owner/name" for per-repo limit check
}

export interface ActiveClaimInfo {
  repoKey?: string; // "owner/name" — needed for per-repo counting
}

export interface EvalContext {
  activeClaims: WorkerClaim[];
  activeClaimRepoKeys: Map<string, string>; // claimId -> repoKey, for per-repo counting
  dispatchQueue: DispatchQueueItem[];
  activeBatch: Batch | null;
  maxAgents: number;
  perRepoLimits: Record<string, number>; // repoKey -> max concurrent
  diskSpaceOk: boolean;
}

// ---------------------------------------------------------------------------
// Per-type constraints
// ---------------------------------------------------------------------------

// Worker and planner minimums are 0 because they require specific issue numbers
// to work on — a minimum-spawned worker with no issue would have no work to do.
// Workers are dispatched from the queue/batch fill steps instead.
const TYPE_MINIMUMS: Record<AgentType, number> = {
  worker: 0,
  reviewer: 1,
  po: 1,
  planner: 0,
  'codebase-reviewer': 0,
  'tech-lead': 0,
};

const TYPE_MAXIMUMS: Record<AgentType, number> = {
  po: 1,
  planner: 1,
  reviewer: 1,
  worker: Infinity, // capped by maxAgents
  'codebase-reviewer': 1,
  'tech-lead': 1,
};

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

export function evaluatePool(ctx: EvalContext): SpawnDecision[] {
  // Guard: disk space
  if (!ctx.diskSpaceOk) return [];

  // 1. Count active claims by agent type
  const activeCounts: Record<AgentType, number> = {
    worker: 0,
    reviewer: 0,
    po: 0,
    planner: 0,
    'codebase-reviewer': 0,
    'tech-lead': 0,
  };
  for (const claim of ctx.activeClaims) {
    if (isActiveClaimStatus(claim.status)) {
      activeCounts[claim.agentType]++;
    }
  }

  const totalActive =
    activeCounts.worker +
    activeCounts.reviewer +
    activeCounts.po +
    activeCounts.planner +
    activeCounts['codebase-reviewer'] +
    activeCounts['tech-lead'];
  let remaining = ctx.maxAgents - totalActive;
  if (remaining <= 0) return [];

  const decisions: SpawnDecision[] = [];

  // 2. Spawn to meet per-type minimums (po: 1, reviewer: 1)
  for (const agentType of [
    'po',
    'reviewer',
    'worker',
    'planner',
    'codebase-reviewer',
    'tech-lead',
  ] satisfies AgentType[]) {
    const min = TYPE_MINIMUMS[agentType];
    const max = TYPE_MAXIMUMS[agentType];
    const current = activeCounts[agentType];
    const needed = Math.min(min - current, max - current);
    for (let i = 0; i < needed && remaining > 0; i++) {
      decisions.push({ issueNumber: 0, agentType, batchItemId: null });
      remaining--;
    }
  }

  // 3. Fill remaining slots from immediate dispatch queue (FIFO)
  // Count existing active claims per repo for per-repo limit enforcement
  const repoActiveCounts: Record<string, number> = {};
  for (const claim of ctx.activeClaims) {
    if (isActiveClaimStatus(claim.status)) {
      const repoKey = ctx.activeClaimRepoKeys.get(claim.id);
      if (repoKey) {
        repoActiveCounts[repoKey] = (repoActiveCounts[repoKey] ?? 0) + 1;
      }
    }
  }

  for (const item of ctx.dispatchQueue) {
    if (remaining <= 0) break;

    // Per-type max check for workers
    const currentWorkers =
      activeCounts.worker +
      decisions.filter((d) => d.agentType === 'worker').length;
    if (currentWorkers >= TYPE_MAXIMUMS.worker) break;

    // Per-repo limit check (counts existing claims + new decisions)
    if (item.repoKey && ctx.perRepoLimits[item.repoKey] !== undefined) {
      const repoLimit = ctx.perRepoLimits[item.repoKey]!;
      const repoCount = repoActiveCounts[item.repoKey] ?? 0;
      if (repoCount >= repoLimit) continue;
      repoActiveCounts[item.repoKey] = repoCount + 1;
    }

    decisions.push({
      issueNumber: item.issueNumber,
      agentType: 'worker',
      batchItemId: null,
    });
    remaining--;
  }

  // 4. Fill remaining slots from active batch ready set (dependency order)
  if (ctx.activeBatch && ctx.activeBatch.status === 'active' && remaining > 0) {
    const readyItems = getReadyBatchItems(ctx.activeBatch);
    for (const item of readyItems) {
      if (remaining <= 0) break;

      const currentWorkers =
        activeCounts.worker +
        decisions.filter((d) => d.agentType === 'worker').length;
      if (currentWorkers >= TYPE_MAXIMUMS.worker) break;

      // Per-repo limit check (same logic as dispatch queue above)
      if (item.repoKey && ctx.perRepoLimits[item.repoKey] !== undefined) {
        const repoLimit = ctx.perRepoLimits[item.repoKey]!;
        const repoCount = repoActiveCounts[item.repoKey] ?? 0;
        if (repoCount >= repoLimit) continue;
        repoActiveCounts[item.repoKey] = repoCount + 1;
      }

      decisions.push({
        issueNumber: item.issueNumber,
        agentType: 'worker',
        batchItemId: item.id,
      });
      remaining--;
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns batch items whose dependencies are all terminal-satisfied and whose own status is 'pending'. */
function getReadyBatchItems(batch: Batch) {
  const statusById = new Map(batch.items.map((i) => [i.id, i.status]));

  return batch.items.filter((item) => {
    // Only pending items can be spawned
    if (item.status !== 'pending') return false;

    // All dependencies must be terminal-satisfied
    return item.dependencies.every((depId) => {
      const depStatus = statusById.get(depId);
      return depStatus !== undefined && isTerminalSatisfied(depStatus);
    });
  });
}
