// src/session-runtime/cost.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CostTracker } from './cost.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
  });

  it('starts with zero daily cost', () => {
    expect(tracker.getDailyCost()).toBe(0);
  });

  it('checkBudget returns available when under budget', () => {
    const result = tracker.checkBudget(1);
    expect(result).toEqual({ available: true, remaining: 50 });
  });

  it('recordCost adds to daily total', () => {
    tracker.recordCost(1, 5);
    expect(tracker.getDailyCost()).toBe(5);
  });

  it('recordCost adds to per-run total', () => {
    tracker.recordCost(42, 3);
    tracker.recordCost(42, 2);
    expect(tracker.getRunCost(42)).toBe(5);
  });

  it('checkBudget rejects when daily budget exceeded', () => {
    tracker.recordCost(1, 51);
    const result = tracker.checkBudget(2);
    expect(result).toEqual({ available: false, reason: 'daily-budget-exceeded' });
  });

  it('checkBudget rejects when per-run budget exceeded', () => {
    tracker.recordCost(1, 11);
    const result = tracker.checkBudget(1);
    expect(result).toEqual({ available: false, reason: 'per-run-budget-exceeded' });
  });

  it('resetDaily clears daily total but keeps run costs', () => {
    tracker.recordCost(1, 5);
    tracker.resetDaily();
    expect(tracker.getDailyCost()).toBe(0);
    expect(tracker.getRunCost(1)).toBe(5);
  });

  it('clearRun removes a specific run cost', () => {
    tracker.recordCost(1, 5);
    tracker.clearRun(1);
    expect(tracker.getRunCost(1)).toBe(0);
  });

  // Regression tests for BUG-9: per-repo budgetLimit ignored
  it('checkBudget uses perRunBudgetOverride when provided', () => {
    tracker.recordCost(1, 5); // under global 10 but over override 3
    const result = tracker.checkBudget(1, 3);
    expect(result).toEqual({ available: false, reason: 'per-run-budget-exceeded' });
  });

  it('checkBudget allows higher override than global default', () => {
    tracker.recordCost(1, 15); // over global 10 but under override 20
    const result = tracker.checkBudget(1, 20);
    expect(result).toEqual({ available: true, remaining: 35 });
  });

  it('checkBudget falls back to global default when no override', () => {
    tracker.recordCost(1, 11); // over global 10
    const result = tracker.checkBudget(1);
    expect(result).toEqual({ available: false, reason: 'per-run-budget-exceeded' });
  });

  it('getSnapshot returns serializable state', () => {
    tracker.recordCost(1, 5);
    const snapshot = tracker.getSnapshot();
    expect(snapshot.dailyCost).toBe(5);
    expect(snapshot.runCosts).toEqual({ '1': 5 });
  });

  // Regression tests for #101: restoreFromSnapshot zero test coverage
  describe('restoreFromSnapshot', () => {
    it('restores dailyCost from snapshot', () => {
      tracker.restoreFromSnapshot({
        dailyCost: 25,
        runCosts: {},
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      expect(tracker.getDailyCost()).toBe(25);
    });

    it('restores runCosts from snapshot with numeric key coercion', () => {
      tracker.restoreFromSnapshot({
        dailyCost: 10,
        runCosts: { '42': 7, '99': 3 },
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      expect(tracker.getRunCost(42)).toBe(7);
      expect(tracker.getRunCost(99)).toBe(3);
    });

    it('restores resetAt from snapshot ISO string', () => {
      const futureDate = new Date(Date.now() + 7200_000);
      tracker.restoreFromSnapshot({
        dailyCost: 0,
        runCosts: {},
        resetAt: futureDate.toISOString(),
      });
      // After restore, daily reset should not trigger (resetAt is in the future)
      expect(tracker.maybeResetDaily()).toBe(false);
    });

    it('clears previous runCosts before restoring', () => {
      tracker.recordCost(1, 5);
      tracker.restoreFromSnapshot({
        dailyCost: 0,
        runCosts: { '2': 3 },
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      expect(tracker.getRunCost(1)).toBe(0); // old run cost cleared
      expect(tracker.getRunCost(2)).toBe(3); // new run cost present
    });

    it('round-trips through getSnapshot → restoreFromSnapshot', () => {
      tracker.recordCost(10, 4.5);
      tracker.recordCost(20, 2.1);
      const snapshot = tracker.getSnapshot();

      const other = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
      other.restoreFromSnapshot(snapshot);

      expect(other.getDailyCost()).toBe(tracker.getDailyCost());
      expect(other.getRunCost(10)).toBe(tracker.getRunCost(10));
      expect(other.getRunCost(20)).toBe(tracker.getRunCost(20));
      // Verify resetAt survived the round trip
      expect(other.maybeResetDaily()).toBe(tracker.maybeResetDaily());
    });

    it('restored state affects checkBudget correctly', () => {
      tracker.restoreFromSnapshot({
        dailyCost: 48,
        runCosts: { '5': 9 },
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      // Verify per-run cost was restored
      expect(tracker.getRunCost(5)).toBe(9);
      // Daily budget is 50, so 48 is still available
      expect(tracker.checkBudget(5)).toEqual({ available: true, remaining: 2 });
      // But per-run budget (10) for issue 5 is 9, still available
      tracker.recordCost(5, 1);
      // Now run cost is 10, per-run exceeded
      expect(tracker.checkBudget(5)).toEqual({
        available: false,
        reason: 'per-run-budget-exceeded',
      });
    });

    it('handles empty runCosts in snapshot', () => {
      tracker.recordCost(1, 5); // pre-existing
      tracker.restoreFromSnapshot({
        dailyCost: 0,
        runCosts: {},
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      expect(tracker.getDailyCost()).toBe(0);
      expect(tracker.getRunCost(1)).toBe(0);
    });

    it('restores with past resetAt triggers immediate daily reset', () => {
      tracker.restoreFromSnapshot({
        dailyCost: 30,
        runCosts: { '1': 5 },
        resetAt: new Date(Date.now() - 1000).toISOString(), // in the past
      });
      // maybeResetDaily should trigger because resetAt is in the past
      expect(tracker.maybeResetDaily()).toBe(true);
      expect(tracker.getDailyCost()).toBe(0);
    });
  });
});
