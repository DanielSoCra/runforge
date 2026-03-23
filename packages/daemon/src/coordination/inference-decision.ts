// src/coordination/inference-decision.ts — Confidence gating, deterministic fallbacks, inference log
import type { InferenceContext, InferenceDecision, DecisionType } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic fallback table — used when model provider is unavailable
// ---------------------------------------------------------------------------

export const DETERMINISTIC_FALLBACKS: Record<DecisionType, string> = {
  stuck_detection: 'stuck',
  retry_skip_replan: 'retry',
  impediment_routing: 'escalate_operator',
  batch_rebalancing: 'let_finish',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InferenceEngineConfig {
  confidenceThreshold: number;  // default 0.6
  inferenceTimeoutMs: number;   // default 10_000
  logCapacity: number;          // ring buffer cap, default 100
  budgetPerTick: number;        // max inference cost per tick, default 1.0
  estimateCostPerCall: number;  // estimated cost per inference call, default 0.1
}

export interface InferenceEngineDeps {
  /** Lightweight single-turn inference call — returns parsed InferenceDecision. */
  infer: (context: InferenceContext) => Promise<Omit<InferenceDecision, 'timestamp' | 'degraded'>>;
  saveLog: (log: InferenceDecision[]) => Promise<void>;
  loadLog: () => Promise<InferenceDecision[]>;
  onBudgetExhausted?: () => void;
}

export interface InferenceEngine {
  decide: (context: InferenceContext) => Promise<InferenceDecision>;
  shouldAct: (decision: InferenceDecision) => boolean;
  getRecentDecisions: (count: number) => Promise<InferenceDecision[]>;
  resetTickBudget: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createInferenceEngine(
  deps: InferenceEngineDeps,
  config: InferenceEngineConfig,
): InferenceEngine {
  let tickBudgetRemaining = config.budgetPerTick;
  let consecutiveExhaustions = 0;

  function resetTickBudget(): void {
    if (tickBudgetRemaining <= 0) {
      consecutiveExhaustions++;
      if (consecutiveExhaustions >= 2 && deps.onBudgetExhausted) {
        deps.onBudgetExhausted();
      }
    } else {
      consecutiveExhaustions = 0;
    }
    tickBudgetRemaining = config.budgetPerTick;
  }

  async function decide(context: InferenceContext): Promise<InferenceDecision> {
    const timestamp = new Date().toISOString();

    let decision: InferenceDecision;

    // Per-tick budget check — fall back to deterministic rules if exhausted
    if (tickBudgetRemaining <= 0) {
      decision = {
        decisionType: context.decisionType,
        chosenAction: DETERMINISTIC_FALLBACKS[context.decisionType],
        confidence: 1.0,
        rationale: 'Deterministic fallback — per-tick inference budget exhausted',
        timestamp,
        degraded: true,
      };
    } else {
      try {
        const raw = await Promise.race([
          deps.infer(context),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('inference timeout')), config.inferenceTimeoutMs),
          ),
        ]);

        tickBudgetRemaining -= config.estimateCostPerCall;

        decision = {
          ...raw,
          timestamp,
          degraded: false,
        };
      } catch {
        // Deterministic fallback
        decision = {
          decisionType: context.decisionType,
          chosenAction: DETERMINISTIC_FALLBACKS[context.decisionType],
          confidence: 1.0,
          rationale: 'Deterministic fallback — inference unavailable',
          timestamp,
          degraded: true,
        };
      }
    }

    // Append to ring buffer log
    const log = await deps.loadLog();
    log.push(decision);
    while (log.length > config.logCapacity) {
      log.shift();
    }
    await deps.saveLog(log);

    return decision;
  }

  function shouldAct(decision: InferenceDecision): boolean {
    return decision.confidence >= config.confidenceThreshold;
  }

  async function getRecentDecisions(count: number): Promise<InferenceDecision[]> {
    const log = await deps.loadLog();
    return log.slice(-count);
  }

  return { decide, shouldAct, getRecentDecisions, resetTickBudget };
}
