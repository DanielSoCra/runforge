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
});
