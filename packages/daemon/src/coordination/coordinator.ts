// src/coordination/coordinator.ts — Tick-driven loop for agent pool management
import { evaluatePool, type EvalContext, type SpawnDecision, type DispatchQueueItem } from './concurrency.js';
import type { WorkerClaim, InferenceContext } from './types.js';
import type { WorkClaimer } from './work-claimer.js';
import type { BatchManager } from './batch-manager.js';
import type { MergeAgent } from './merge-agent.js';
import type { InferenceEngine } from './inference-decision.js';
import type { ProtocolOrchestrator } from './protocol-orchestrator.js';

export interface CoordinatorConfig {
  tickIntervalMs: number;
  maxAgents: number;
  diskSpaceThreshold: number;
  perRepoLimits: Record<string, number>;
  maxConsecutiveTickErrors: number;
}

export interface PendingDecision {
  context: InferenceContext;
  onResult: (chosenAction: string, acted: boolean) => Promise<void>;
}

export interface CoordinatorDeps {
  workClaimer: WorkClaimer;
  batchManager: BatchManager;
  mergeAgent: MergeAgent;
  inferenceEngine?: InferenceEngine;
  protocolOrchestrator?: ProtocolOrchestrator;
  spawnWorker: (claim: WorkerClaim, decision: SpawnDecision) => Promise<void>;
  checkDiskSpace: () => Promise<boolean>;
  getDispatchQueue: () => Promise<DispatchQueueItem[]>;
  getActiveClaimRepoKeys: () => Promise<Map<string, string>>;
  getPendingDecisions?: () => Promise<PendingDecision[]>;
  onMergeAgentCrash: (callback: () => void) => void;
  isPaused: () => boolean;
  isShuttingDown: () => boolean;
  onTickErrorThresholdReached: (consecutiveErrors: number, lastError: unknown) => void;
}

export interface Coordinator {
  start(): () => void;
}

export function createCoordinator(deps: CoordinatorDeps, config: CoordinatorConfig): Coordinator {
  function start(): () => void {
    let stopped = false;
    let tickInProgress = false;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    let consecutiveTickErrors = 0;

    // Start Merge Agent
    const stopMergeAgent = deps.mergeAgent.start();

    // Register crash handler — restart Merge Agent unless paused/shutting down
    deps.onMergeAgentCrash(() => {
      if (deps.isPaused() || deps.isShuttingDown()) return;
      deps.mergeAgent.start();
    });

    async function tick(): Promise<void> {
      if (stopped || deps.isPaused()) return;
      if (tickInProgress) return;
      tickInProgress = true;
      try {
        // --- Reset per-tick inference budget ---
        if (deps.inferenceEngine) {
          deps.inferenceEngine.resetTickBudget();
        }

        // --- Process pending inference decisions (at most one per decision point per tick) ---
        if (deps.inferenceEngine && deps.getPendingDecisions) {
          const pending = await deps.getPendingDecisions();
          for (const item of pending) {
            const decision = await deps.inferenceEngine.decide(item.context);
            const acted = deps.inferenceEngine.shouldAct(decision);
            await item.onResult(decision.chosenAction, acted);
          }
        }

        // --- Concurrency evaluation ---
        const diskSpaceOk = await deps.checkDiskSpace();
        const activeClaims = await deps.workClaimer.listActive();
        const activeClaimRepoKeys = await deps.getActiveClaimRepoKeys();
        const dispatchQueue = await deps.getDispatchQueue();
        const activeBatch = await deps.batchManager.getActive();

        const ctx: EvalContext = {
          activeClaims,
          activeClaimRepoKeys,
          dispatchQueue,
          activeBatch,
          maxAgents: config.maxAgents,
          perRepoLimits: config.perRepoLimits,
          diskSpaceOk,
        };

        const decisions = evaluatePool(ctx);

        // Execute spawn decisions
        for (const decision of decisions) {
          if (decision.issueNumber === 0) {
            // Minimum-fill spawn (po, reviewer) — no claim needed
            await deps.spawnWorker(
              { id: '', issueNumber: 0, attempt: 0, batchItemId: null, sessionId: null, worktreePath: null, prNumber: null, agentType: decision.agentType, status: 'claimed', failureReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies WorkerClaim,
              decision,
            );
            continue;
          }

          // Claim the issue before spawning
          const claimResult = await deps.workClaimer.claim(
            decision.issueNumber,
            decision.agentType,
            decision.batchItemId ?? undefined,
          );

          if (!claimResult.ok) continue; // Already claimed or error — skip

          await deps.spawnWorker(claimResult.value, decision);
        }
        consecutiveTickErrors = 0;
      } finally {
        tickInProgress = false;
      }
    }

    tickTimer = setInterval(() => {
      tick().catch((e) => {
        consecutiveTickErrors++;
        console.error(`[coordinator] tick error (${consecutiveTickErrors}/${config.maxConsecutiveTickErrors}):`, e);
        if (consecutiveTickErrors >= config.maxConsecutiveTickErrors) {
          console.error(`[coordinator] ${consecutiveTickErrors} consecutive tick errors — triggering error recovery`);
          deps.onTickErrorThresholdReached(consecutiveTickErrors, e);
        }
      });
    }, config.tickIntervalMs);

    return () => {
      stopped = true;
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      stopMergeAgent();
    };
  }

  return { start };
}
