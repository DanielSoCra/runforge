// src/coordination/inference-decision.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInferenceEngine,
  DETERMINISTIC_FALLBACKS,
  type InferenceEngine,
  type InferenceEngineDeps,
  type InferenceEngineConfig,
} from './inference-decision.js';
import type { InferenceContext, InferenceDecision } from './types.js';

function makeConfig(overrides: Partial<InferenceEngineConfig> = {}): InferenceEngineConfig {
  return {
    confidenceThreshold: 0.6,
    inferenceTimeoutMs: 10_000,
    logCapacity: 100,
    budgetPerTick: 1.0,
    estimateCostPerCall: 0.1,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<InferenceEngineDeps> = {}): InferenceEngineDeps {
  return {
    infer: vi.fn().mockResolvedValue({
      decisionType: 'stuck_detection',
      chosenAction: 'stuck',
      confidence: 0.8,
      rationale: 'No progress in 48 hours',
    }),
    saveLog: vi.fn().mockResolvedValue(undefined),
    loadLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeContext(overrides: Partial<InferenceContext> = {}): InferenceContext {
  return {
    decisionType: 'stuck_detection',
    workItemId: 'item-1',
    stateSnapshot: { status: 'in_progress' },
    recentActivity: [],
    failureReason: null,
    ...overrides,
  };
}

describe('InferenceEngine', () => {
  describe('decide()', () => {
    it('returns inference decision when confidence is above threshold', async () => {
      const deps = makeDeps();
      const engine = createInferenceEngine(deps, makeConfig());

      const result = await engine.decide(makeContext());

      expect(result.chosenAction).toBe('stuck');
      expect(result.confidence).toBe(0.8);
      expect(result.degraded).toBe(false);
    });

    it('returns decision with low confidence (caller gates on it)', async () => {
      const deps = makeDeps({
        infer: vi.fn().mockResolvedValue({
          decisionType: 'stuck_detection',
          chosenAction: 'not_stuck',
          confidence: 0.3,
          rationale: 'Ambiguous signal',
        }),
      });
      const engine = createInferenceEngine(deps, makeConfig());

      const result = await engine.decide(makeContext());

      expect(result.chosenAction).toBe('not_stuck');
      expect(result.confidence).toBe(0.3);
      expect(result.degraded).toBe(false);
    });

    it('falls back to deterministic rule on inference error', async () => {
      const deps = makeDeps({
        infer: vi.fn().mockRejectedValue(new Error('model unavailable')),
      });
      const engine = createInferenceEngine(deps, makeConfig());

      const result = await engine.decide(makeContext({ decisionType: 'stuck_detection' }));

      expect(result.chosenAction).toBe(DETERMINISTIC_FALLBACKS.stuck_detection);
      expect(result.degraded).toBe(true);
    });

    it('falls back to deterministic rule on inference timeout', async () => {
      const deps = makeDeps({
        infer: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 20_000)),
        ),
      });
      const engine = createInferenceEngine(deps, makeConfig({ inferenceTimeoutMs: 50 }));

      const result = await engine.decide(makeContext({ decisionType: 'retry_skip_replan' }));

      expect(result.chosenAction).toBe(DETERMINISTIC_FALLBACKS.retry_skip_replan);
      expect(result.degraded).toBe(true);
    });

    it('uses correct fallback for each decision type', async () => {
      const deps = makeDeps({
        infer: vi.fn().mockRejectedValue(new Error('unavailable')),
      });
      const engine = createInferenceEngine(deps, makeConfig());

      const stuckResult = await engine.decide(makeContext({ decisionType: 'stuck_detection' }));
      expect(stuckResult.chosenAction).toBe('stuck');

      const retryResult = await engine.decide(makeContext({ decisionType: 'retry_skip_replan' }));
      expect(retryResult.chosenAction).toBe('retry');

      const routeResult = await engine.decide(makeContext({ decisionType: 'impediment_routing' }));
      expect(routeResult.chosenAction).toBe('escalate_operator');

      const balanceResult = await engine.decide(makeContext({ decisionType: 'batch_rebalancing' }));
      expect(balanceResult.chosenAction).toBe('let_finish');
    });

    it('adds timestamp to decision', async () => {
      const deps = makeDeps();
      const engine = createInferenceEngine(deps, makeConfig());

      const result = await engine.decide(makeContext());

      expect(result.timestamp).toBeDefined();
    });
  });

  describe('shouldAct()', () => {
    it('returns true when confidence meets threshold', () => {
      const engine = createInferenceEngine(makeDeps(), makeConfig({ confidenceThreshold: 0.6 }));

      expect(engine.shouldAct({ confidence: 0.6 } as InferenceDecision)).toBe(true);
      expect(engine.shouldAct({ confidence: 0.9 } as InferenceDecision)).toBe(true);
    });

    it('returns false when confidence is below threshold', () => {
      const engine = createInferenceEngine(makeDeps(), makeConfig({ confidenceThreshold: 0.6 }));

      expect(engine.shouldAct({ confidence: 0.59 } as InferenceDecision)).toBe(false);
      expect(engine.shouldAct({ confidence: 0.0 } as InferenceDecision)).toBe(false);
    });
  });

  describe('inference log (ring buffer)', () => {
    it('appends decisions to the log', async () => {
      const savedLogs: InferenceDecision[][] = [];
      const deps = makeDeps({
        saveLog: vi.fn().mockImplementation((log: InferenceDecision[]) => {
          savedLogs.push([...log]);
          return Promise.resolve();
        }),
        loadLog: vi.fn().mockResolvedValue([]),
      });
      const engine = createInferenceEngine(deps, makeConfig());

      await engine.decide(makeContext());

      expect(savedLogs.length).toBe(1);
      expect(savedLogs[0]!.length).toBe(1);
    });

    it('caps log at configured capacity (ring buffer)', async () => {
      const existingLog: InferenceDecision[] = Array.from({ length: 100 }, (_, i) => ({
        decisionType: 'stuck_detection' as const,
        chosenAction: 'stuck',
        confidence: 0.8,
        rationale: `entry-${i}`,
        timestamp: new Date().toISOString(),
        degraded: false,
      }));

      let savedLog: InferenceDecision[] = [];
      const deps = makeDeps({
        saveLog: vi.fn().mockImplementation((log: InferenceDecision[]) => {
          savedLog = [...log];
          return Promise.resolve();
        }),
        loadLog: vi.fn().mockResolvedValue(existingLog),
      });
      const engine = createInferenceEngine(deps, makeConfig({ logCapacity: 100 }));

      await engine.decide(makeContext());

      expect(savedLog.length).toBe(100);
      // The oldest entry should have been evicted
      expect(savedLog[0]!.rationale).toBe('entry-1'); // entry-0 evicted
    });

    it('getRecentDecisions returns last N entries', async () => {
      const existingLog: InferenceDecision[] = Array.from({ length: 10 }, (_, i) => ({
        decisionType: 'stuck_detection' as const,
        chosenAction: 'stuck',
        confidence: 0.8,
        rationale: `entry-${i}`,
        timestamp: new Date().toISOString(),
        degraded: false,
      }));

      const deps = makeDeps({
        loadLog: vi.fn().mockResolvedValue(existingLog),
      });
      const engine = createInferenceEngine(deps, makeConfig());

      const recent = await engine.getRecentDecisions(5);

      expect(recent.length).toBe(5);
      expect(recent[0]!.rationale).toBe('entry-5');
    });
  });

  describe('per-tick inference budget', () => {
    it('falls back to deterministic rules when budget is exhausted', async () => {
      const deps = makeDeps();
      // Budget of 0.1 with cost 0.1 per call = 1 real call, then budget hits 0
      const engine = createInferenceEngine(deps, makeConfig({
        budgetPerTick: 0.1,
        estimateCostPerCall: 0.1,
      }));

      // First call succeeds (uses real inference) and exhausts budget
      const first = await engine.decide(makeContext());
      expect(first.degraded).toBe(false);

      // Second call — budget is exhausted, falls back
      const second = await engine.decide(makeContext());
      expect(second.degraded).toBe(true);
      expect(second.rationale).toContain('budget exhausted');
    });

    it('resets budget on resetTickBudget()', async () => {
      const deps = makeDeps();
      const engine = createInferenceEngine(deps, makeConfig({
        budgetPerTick: 0.1,
        estimateCostPerCall: 0.1,
      }));

      await engine.decide(makeContext()); // uses budget, exhausts it
      await engine.decide(makeContext()); // falls back (budget exhausted)

      engine.resetTickBudget(); // reset

      const afterReset = await engine.decide(makeContext());
      expect(afterReset.degraded).toBe(false); // real inference again
    });

    it('notifies on consecutive budget exhaustions', async () => {
      const onBudgetExhausted = vi.fn();
      const deps = makeDeps({ onBudgetExhausted });
      const engine = createInferenceEngine(deps, makeConfig({
        budgetPerTick: 0.05,
        estimateCostPerCall: 0.1,
      }));

      // Tick 1: exhaust budget
      await engine.decide(makeContext());
      engine.resetTickBudget(); // budget was 0 after call → consecutive=1

      // Tick 2: exhaust budget again
      await engine.decide(makeContext());
      engine.resetTickBudget(); // consecutive=2 → triggers notification

      expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
    });

    it('resets consecutive counter when budget is not exhausted', async () => {
      const onBudgetExhausted = vi.fn();
      const deps = makeDeps({ onBudgetExhausted });
      const engine = createInferenceEngine(deps, makeConfig({
        budgetPerTick: 1.0, // plenty of budget
        estimateCostPerCall: 0.1,
      }));

      await engine.decide(makeContext());
      engine.resetTickBudget(); // budget not exhausted → consecutive=0

      await engine.decide(makeContext());
      engine.resetTickBudget(); // still not exhausted → consecutive=0

      expect(onBudgetExhausted).not.toHaveBeenCalled();
    });
  });
});
