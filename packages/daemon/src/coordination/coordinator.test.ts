// src/coordination/coordinator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCoordinator, type CoordinatorDeps, type CoordinatorConfig } from './coordinator.js';
import type { WorkerClaim, AgentType, ClaimStatus, Batch, BatchItem } from './types.js';
import type { SpawnDecision } from './concurrency.js';

function makeClaim(overrides: Partial<WorkerClaim> & { agentType: AgentType }): WorkerClaim {
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

function makeConfig(overrides: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
  return {
    tickIntervalMs: 5000,
    maxAgents: 10,
    diskSpaceThreshold: 2_000_000_000,
    perRepoLimits: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    workClaimer: {
      claim: vi.fn().mockResolvedValue({ ok: true, value: makeClaim({ agentType: 'worker' }) }),
      findActiveClaim: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      listActive: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
    },
    batchManager: {
      create: vi.fn(),
      transition: vi.fn(),
      getActive: vi.fn().mockResolvedValue(null),
      getReadySet: vi.fn().mockResolvedValue([]),
      updateItemStatus: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
    mergeAgent: {
      processEntry: vi.fn(),
      recoverStuckEntries: vi.fn(),
      start: vi.fn().mockReturnValue(() => {}),
    },
    spawnWorker: vi.fn().mockResolvedValue(undefined),
    checkDiskSpace: vi.fn().mockResolvedValue(true),
    getDispatchQueue: vi.fn().mockResolvedValue([]),
    getActiveClaimRepoKeys: vi.fn().mockResolvedValue(new Map()),
    onMergeAgentCrash: vi.fn(),
    isPaused: vi.fn().mockReturnValue(false),
    isShuttingDown: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe('Coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evaluates pool on each tick and spawns workers', async () => {
    const deps = makeDeps({
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    // Advance past first tick
    await vi.advanceTimersByTimeAsync(150);

    expect(deps.spawnWorker).toHaveBeenCalled();
    stop();
  });

  it('does not spawn when paused', async () => {
    const deps = makeDeps({
      isPaused: vi.fn().mockReturnValue(true),
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(deps.spawnWorker).not.toHaveBeenCalled();
    stop();
  });

  it('does not spawn when disk space is low', async () => {
    const deps = makeDeps({
      checkDiskSpace: vi.fn().mockResolvedValue(false),
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(deps.spawnWorker).not.toHaveBeenCalled();
    stop();
  });

  it('starts merge agent on start and restarts on crash', async () => {
    let crashCallback: (() => void) | undefined;
    const mergeAgentStop = vi.fn();
    const deps = makeDeps({
      mergeAgent: {
        processEntry: vi.fn(),
        recoverStuckEntries: vi.fn(),
        start: vi.fn().mockReturnValue(mergeAgentStop),
      },
      onMergeAgentCrash: vi.fn().mockImplementation((cb) => {
        crashCallback = cb;
      }),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    expect(deps.mergeAgent.start).toHaveBeenCalledTimes(1);

    // Simulate crash
    crashCallback!();
    expect(deps.mergeAgent.start).toHaveBeenCalledTimes(2);

    stop();
  });

  it('does not restart merge agent when shutting down', async () => {
    let crashCallback: (() => void) | undefined;
    const deps = makeDeps({
      mergeAgent: {
        processEntry: vi.fn(),
        recoverStuckEntries: vi.fn(),
        start: vi.fn().mockReturnValue(() => {}),
      },
      onMergeAgentCrash: vi.fn().mockImplementation((cb) => {
        crashCallback = cb;
      }),
      isShuttingDown: vi.fn().mockReturnValue(true),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    // Simulate crash during shutdown
    crashCallback!();
    expect(deps.mergeAgent.start).toHaveBeenCalledTimes(1); // Only initial start, no restart

    stop();
  });

  it('does not restart merge agent when paused', async () => {
    let crashCallback: (() => void) | undefined;
    const deps = makeDeps({
      mergeAgent: {
        processEntry: vi.fn(),
        recoverStuckEntries: vi.fn(),
        start: vi.fn().mockReturnValue(() => {}),
      },
      onMergeAgentCrash: vi.fn().mockImplementation((cb) => {
        crashCallback = cb;
      }),
      isPaused: vi.fn().mockReturnValue(true),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    crashCallback!();
    expect(deps.mergeAgent.start).toHaveBeenCalledTimes(1); // Only initial start

    stop();
  });

  it('stop() clears interval and stops merge agent', async () => {
    const mergeAgentStop = vi.fn();
    const deps = makeDeps({
      mergeAgent: {
        processEntry: vi.fn(),
        recoverStuckEntries: vi.fn(),
        start: vi.fn().mockReturnValue(mergeAgentStop),
      },
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    stop();

    // Advance time — no more ticks should fire
    await vi.advanceTimersByTimeAsync(500);
    // spawnWorker should not be called since stop was called immediately
    expect(deps.spawnWorker).not.toHaveBeenCalled();
    expect(mergeAgentStop).toHaveBeenCalled();
  });

  it('claims issue before spawning worker', async () => {
    const claim = makeClaim({ agentType: 'worker', issueNumber: 42 });
    const deps = makeDeps({
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
      workClaimer: {
        claim: vi.fn().mockResolvedValue({ ok: true, value: claim }),
        findActiveClaim: vi.fn().mockResolvedValue(null),
        updateStatus: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        listActive: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(deps.workClaimer.claim).toHaveBeenCalledWith(42, 'worker', undefined);
    expect(deps.spawnWorker).toHaveBeenCalled();
    stop();
  });

  it('skips spawn if claim fails', async () => {
    // Pre-fill minimums so only the dispatch queue item triggers a claim
    const poClaim = makeClaim({ agentType: 'po', issueNumber: 0 });
    const reviewerClaim = makeClaim({ agentType: 'reviewer', issueNumber: 0 });
    const deps = makeDeps({
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
      workClaimer: {
        claim: vi.fn().mockResolvedValue({ ok: false, error: new Error('already claimed') }),
        findActiveClaim: vi.fn().mockResolvedValue(null),
        updateStatus: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        listActive: vi.fn().mockResolvedValue([poClaim, reviewerClaim]),
        listAll: vi.fn().mockResolvedValue([poClaim, reviewerClaim]),
      },
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    await vi.advanceTimersByTimeAsync(150);

    // spawnWorker should NOT have been called for issue 42 since claim failed
    const workerCalls = (deps.spawnWorker as ReturnType<typeof vi.fn>).mock.calls;
    const issue42Calls = workerCalls.filter((args: unknown[]) => {
      const decision = args[1] as SpawnDecision;
      return decision.issueNumber === 42;
    });
    expect(issue42Calls).toHaveLength(0);
    stop();
  });

  it('fills from batch ready set after dispatch queue', async () => {
    const batchItem: BatchItem = {
      id: 'item-1',
      issueNumber: 99,
      status: 'pending',
      dependencies: [],
    };
    const batch: Batch = {
      id: 'batch-1',
      status: 'active',
      targetWorkerCount: 3,
      budgetEstimate: 100,
      items: [batchItem],
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      completedAt: null,
    };
    const deps = makeDeps({
      batchManager: {
        create: vi.fn(),
        transition: vi.fn(),
        getActive: vi.fn().mockResolvedValue(batch),
        getReadySet: vi.fn().mockResolvedValue([]),
        updateItemStatus: vi.fn(),
        list: vi.fn().mockResolvedValue([batch]),
      },
      workClaimer: {
        claim: vi.fn().mockResolvedValue({ ok: true, value: makeClaim({ agentType: 'worker', issueNumber: 99 }) }),
        findActiveClaim: vi.fn().mockResolvedValue(null),
        updateStatus: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        listActive: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    await vi.advanceTimersByTimeAsync(150);

    // The evaluatePool function should have been called with the active batch
    // and spawned a worker for issue 99
    expect(deps.spawnWorker).toHaveBeenCalled();
    stop();
  });

  it('does not overlap ticks — re-entrancy guard prevents concurrent tick execution', async () => {
    // Simulate a slow tick: checkDiskSpace takes longer than the tick interval
    let diskCheckResolve: (() => void) | undefined;
    const slowDiskCheck = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => {
        diskCheckResolve = () => resolve(true);
      }),
    );
    const deps = makeDeps({
      checkDiskSpace: slowDiskCheck,
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    // First tick fires at 100ms — starts but blocks on disk check
    await vi.advanceTimersByTimeAsync(100);
    expect(slowDiskCheck).toHaveBeenCalledTimes(1);

    // Second tick fires at 200ms — should be skipped because first is still in progress
    await vi.advanceTimersByTimeAsync(100);
    expect(slowDiskCheck).toHaveBeenCalledTimes(1); // NOT 2

    // Complete the first tick
    diskCheckResolve!();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Third tick fires at 300ms — should run normally since first completed
    await vi.advanceTimersByTimeAsync(100);
    expect(slowDiskCheck).toHaveBeenCalledTimes(2);

    stop();
  });

  it('resets re-entrancy guard even if tick throws', async () => {
    let callCount = 0;
    const deps = makeDeps({
      checkDiskSpace: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('disk error'));
        return Promise.resolve(true);
      }),
      getDispatchQueue: vi.fn().mockResolvedValue([{ issueNumber: 42 }]),
    });
    const config = makeConfig({ tickIntervalMs: 100 });
    const coordinator = createCoordinator(deps, config);
    const stop = coordinator.start();

    // First tick fires and throws
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);

    // Second tick should still run (guard was reset in finally block)
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    stop();
  });
});
