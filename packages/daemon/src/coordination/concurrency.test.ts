// src/coordination/concurrency.test.ts
import { describe, it, expect } from 'vitest';
import { evaluatePool, type EvalContext, type SpawnDecision, type DispatchQueueItem } from './concurrency.js';
import type { WorkerClaim, Batch, AgentType, ClaimStatus } from './types.js';

function makeClaim(
  overrides: Partial<WorkerClaim> & { agentType: AgentType },
): WorkerClaim {
  return {
    id: crypto.randomUUID(),
    issueNumber: 1,
    attempt: 1,
    batchItemId: null,
    sessionId: null,
    worktreePath: null,
    prNumber: null,
    status: 'in_progress' as ClaimStatus,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBatch(items: Batch['items']): Batch {
  return {
    id: crypto.randomUUID(),
    status: 'active',
    targetWorkerCount: 5,
    budgetEstimate: 100,
    items,
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    completedAt: null,
  };
}

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    activeClaims: [],
    activeClaimRepoKeys: new Map(),
    dispatchQueue: [],
    activeBatch: null,
    maxAgents: 10,
    perRepoLimits: {},
    diskSpaceOk: true,
    ...overrides,
  };
}

describe('evaluatePool', () => {
  it('returns empty when no work to dispatch and minimums are met', () => {
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const result = evaluatePool(makeCtx({ activeClaims: claims }));
    expect(result).toEqual([]);
  });

  it('returns empty when at max capacity', () => {
    const claims = [
      makeClaim({ agentType: 'worker', issueNumber: 1 }),
      makeClaim({ agentType: 'worker', issueNumber: 2 }),
      makeClaim({ agentType: 'worker', issueNumber: 3 }),
    ];
    const queue: DispatchQueueItem[] = [{ issueNumber: 99 }];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      dispatchQueue: queue,
      maxAgents: 3,
    }));
    expect(result).toEqual([]);
  });

  it('returns empty when disk space is low', () => {
    const queue: DispatchQueueItem[] = [{ issueNumber: 1 }];
    const result = evaluatePool(makeCtx({
      dispatchQueue: queue,
      diskSpaceOk: false,
    }));
    expect(result).toEqual([]);
  });

  it('enforces per-type minimums — spawns po if missing', () => {
    // Worker and reviewer exist, but no po
    const claims = [
      makeClaim({ agentType: 'worker', issueNumber: 1 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 2 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      maxAgents: 10,
    }));
    // Should spawn po to meet minimum of 1
    const poDecisions = result.filter(d => d.agentType === 'po');
    expect(poDecisions).toHaveLength(1);
    expect(poDecisions[0]!.issueNumber).toBe(0); // sentinel for minimum-spawned agents
    expect(poDecisions[0]!.batchItemId).toBeNull();
  });

  it('enforces per-type minimums — spawns reviewer if missing', () => {
    const claims = [
      makeClaim({ agentType: 'worker', issueNumber: 1 }),
      makeClaim({ agentType: 'po', issueNumber: 2 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      maxAgents: 10,
    }));
    const reviewerDecisions = result.filter(d => d.agentType === 'reviewer');
    expect(reviewerDecisions).toHaveLength(1);
  });

  it('does not spawn planner for minimums (planner minimum is 0)', () => {
    const result = evaluatePool(makeCtx({ maxAgents: 10 }));
    const plannerDecisions = result.filter(d => d.agentType === 'planner');
    expect(plannerDecisions).toHaveLength(0);
  });

  it('does not spawn worker for minimums (worker minimum is 0)', () => {
    // Even with no workers, workers are not spawned via minimums —
    // they come from the dispatch queue or batch
    const result = evaluatePool(makeCtx({ maxAgents: 10 }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    expect(workerDecisions).toHaveLength(0);
  });

  it('fills from dispatch queue after minimums', () => {
    // po + reviewer already exist, so minimums are met
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const queue: DispatchQueueItem[] = [
      { issueNumber: 1 },
      { issueNumber: 2 },
      { issueNumber: 3 },
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      dispatchQueue: queue,
      maxAgents: 10,
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    expect(workerDecisions).toHaveLength(3);
    expect(workerDecisions.map(d => d.issueNumber)).toEqual([1, 2, 3]);
  });

  it('respects FIFO order from dispatch queue', () => {
    const queue: DispatchQueueItem[] = [
      { issueNumber: 10 },
      { issueNumber: 20 },
      { issueNumber: 30 },
    ];
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      dispatchQueue: queue,
      maxAgents: 4, // 2 active + room for 2 from queue
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    expect(workerDecisions.map(d => d.issueNumber)).toEqual([10, 20]);
  });

  it('fills from batch ready set after dispatch queue', () => {
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const itemA = {
      id: crypto.randomUUID(),
      issueNumber: 5,
      status: 'pending' as const,
      dependencies: [],
    };
    const itemB = {
      id: crypto.randomUUID(),
      issueNumber: 6,
      status: 'pending' as const,
      dependencies: [],
    };
    const batch = makeBatch([itemA, itemB]);
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      activeBatch: batch,
      maxAgents: 10,
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    expect(workerDecisions).toHaveLength(2);
    expect(workerDecisions[0]!.batchItemId).toBe(itemA.id);
    expect(workerDecisions[1]!.batchItemId).toBe(itemB.id);
  });

  it('batch items with unsatisfied dependencies are not ready', () => {
    const depId = crypto.randomUUID();
    const itemA = {
      id: depId,
      issueNumber: 5,
      status: 'pending' as const,
      dependencies: [],
    };
    const itemB = {
      id: crypto.randomUUID(),
      issueNumber: 6,
      status: 'pending' as const,
      dependencies: [depId], // depends on A, which is not completed
    };
    const batch = makeBatch([itemA, itemB]);
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      activeBatch: batch,
      maxAgents: 10,
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    // Only itemA should be spawned (itemB has unmet dependency)
    expect(workerDecisions).toHaveLength(1);
    expect(workerDecisions[0]!.batchItemId).toBe(depId);
  });

  it('batch items with satisfied dependencies are ready', () => {
    const depId = crypto.randomUUID();
    const itemA = {
      id: depId,
      issueNumber: 5,
      status: 'completed' as const,
      dependencies: [],
    };
    const itemB = {
      id: crypto.randomUUID(),
      issueNumber: 6,
      status: 'pending' as const,
      dependencies: [depId],
    };
    const batch = makeBatch([itemA, itemB]);
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      activeBatch: batch,
      maxAgents: 10,
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    // itemA is completed so not spawned, itemB is ready
    expect(workerDecisions).toHaveLength(1);
    expect(workerDecisions[0]!.batchItemId).toBe(itemB.id);
  });

  it('per-type maximums — only 1 po allowed', () => {
    const claims = [
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      maxAgents: 10,
    }));
    const poDecisions = result.filter(d => d.agentType === 'po');
    // Minimum spawns 1 po, but never more than 1
    expect(poDecisions).toHaveLength(1);
  });

  it('per-type maximums — does not spawn second po if one is active', () => {
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      maxAgents: 10,
    }));
    const poDecisions = result.filter(d => d.agentType === 'po');
    expect(poDecisions).toHaveLength(0);
  });

  it('per-type maximums — only 1 reviewer allowed', () => {
    const claims = [
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
      makeClaim({ agentType: 'po', issueNumber: 100 }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      maxAgents: 10,
    }));
    const reviewerDecisions = result.filter(d => d.agentType === 'reviewer');
    expect(reviewerDecisions).toHaveLength(0);
  });

  it('per-repo limits prevent over-spawning (counts existing claims)', () => {
    const existingWorker = makeClaim({ agentType: 'worker', issueNumber: 1 });
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
      existingWorker,
    ];
    // Map existing worker to repo-a — it already counts toward the limit
    const activeClaimRepoKeys = new Map([[existingWorker.id, 'org/repo-a']]);
    const queue: DispatchQueueItem[] = [
      { issueNumber: 2, repoKey: 'org/repo-a' },
      { issueNumber: 3, repoKey: 'org/repo-a' },
      { issueNumber: 4, repoKey: 'org/repo-b' },
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      activeClaimRepoKeys,
      dispatchQueue: queue,
      maxAgents: 10,
      perRepoLimits: { 'org/repo-a': 2, 'org/repo-b': 5 },
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    // repo-a: 1 existing + limit 2 = room for 1 more (issue 2 only, not 3)
    // repo-b: 0 existing + limit 5 = issue 4 is fine
    expect(workerDecisions).toHaveLength(2);
    expect(workerDecisions.map(d => d.issueNumber)).toEqual([2, 4]);
  });

  it('priority order: minimums > dispatch queue > batch ready set', () => {
    const queue: DispatchQueueItem[] = [{ issueNumber: 1 }];
    const batchItem = {
      id: crypto.randomUUID(),
      issueNumber: 2,
      status: 'pending' as const,
      dependencies: [],
    };
    const batch = makeBatch([batchItem]);
    // maxAgents = 4: need 2 for minimums (po + reviewer), 1 for queue, 1 for batch
    const result = evaluatePool(makeCtx({
      dispatchQueue: queue,
      activeBatch: batch,
      maxAgents: 4,
    }));
    expect(result).toHaveLength(4);
    // First two should be minimums (po and reviewer)
    const minimumTypes = result.filter(d => d.issueNumber === 0).map(d => d.agentType).sort();
    expect(minimumTypes).toEqual(['po', 'reviewer']);
    // Then dispatch queue
    expect(result.find(d => d.issueNumber === 1 && d.agentType === 'worker')).toBeTruthy();
    // Then batch
    expect(result.find(d => d.issueNumber === 2 && d.batchItemId === batchItem.id)).toBeTruthy();
  });

  it('does not count terminal claims as active', () => {
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100, status: 'completed' }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101, status: 'failed' }),
    ];
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      maxAgents: 10,
    }));
    // Both completed/failed are terminal, so minimums should still spawn po + reviewer
    const poDecisions = result.filter(d => d.agentType === 'po');
    const reviewerDecisions = result.filter(d => d.agentType === 'reviewer');
    expect(poDecisions).toHaveLength(1);
    expect(reviewerDecisions).toHaveLength(1);
  });

  it('does not spawn batch items already in progress', () => {
    const claims = [
      makeClaim({ agentType: 'po', issueNumber: 100 }),
      makeClaim({ agentType: 'reviewer', issueNumber: 101 }),
    ];
    const item = {
      id: crypto.randomUUID(),
      issueNumber: 5,
      status: 'in_progress' as const,
      dependencies: [],
    };
    const batch = makeBatch([item]);
    const result = evaluatePool(makeCtx({
      activeClaims: claims,
      activeBatch: batch,
      maxAgents: 10,
    }));
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    expect(workerDecisions).toHaveLength(0);
  });

  it('capacity is shared across minimums, queue, and batch', () => {
    // maxAgents = 3, need po + reviewer (2 minimum slots), leaving 1 for queue
    const queue: DispatchQueueItem[] = [
      { issueNumber: 1 },
      { issueNumber: 2 },
    ];
    const batchItem = {
      id: crypto.randomUUID(),
      issueNumber: 3,
      status: 'pending' as const,
      dependencies: [],
    };
    const batch = makeBatch([batchItem]);
    const result = evaluatePool(makeCtx({
      dispatchQueue: queue,
      activeBatch: batch,
      maxAgents: 3,
    }));
    // 2 minimums + 1 from queue = 3 total, no room for batch
    expect(result).toHaveLength(3);
    const workerDecisions = result.filter(d => d.agentType === 'worker');
    expect(workerDecisions).toHaveLength(1);
    expect(workerDecisions[0]!.issueNumber).toBe(1);
  });
});
