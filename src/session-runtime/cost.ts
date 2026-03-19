// src/session-runtime/cost.ts

export type BudgetCheck =
  | { available: true; remaining: number }
  | { available: false; reason: 'daily-budget-exceeded' | 'per-run-budget-exceeded' };

export interface CostSnapshot {
  dailyCost: number;
  runCosts: Record<string, number>;
  resetAt: string;
}

export class CostTracker {
  private dailyCost = 0;
  private runCosts = new Map<number, number>();
  private readonly dailyBudget: number;
  private readonly perRunBudget: number;
  private resetAt: Date;

  constructor(config: { dailyBudget: number; perRunBudget: number }) {
    this.dailyBudget = config.dailyBudget;
    this.perRunBudget = config.perRunBudget;
    this.resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  getDailyCost(): number {
    return this.dailyCost;
  }

  getRunCost(issueNumber: number): number {
    return this.runCosts.get(issueNumber) ?? 0;
  }

  checkBudget(issueNumber: number): BudgetCheck {
    if (this.dailyCost >= this.dailyBudget) {
      return { available: false, reason: 'daily-budget-exceeded' };
    }
    if (this.getRunCost(issueNumber) >= this.perRunBudget) {
      return { available: false, reason: 'per-run-budget-exceeded' };
    }
    return { available: true, remaining: this.dailyBudget - this.dailyCost };
  }

  recordCost(issueNumber: number, cost: number): void {
    this.dailyCost += cost;
    this.runCosts.set(issueNumber, this.getRunCost(issueNumber) + cost);
  }

  resetDaily(): void {
    this.dailyCost = 0;
    this.resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  clearRun(issueNumber: number): void {
    this.runCosts.delete(issueNumber);
  }

  getSnapshot(): CostSnapshot {
    const runCosts: Record<string, number> = {};
    for (const [k, v] of this.runCosts) {
      runCosts[String(k)] = v;
    }
    return {
      dailyCost: this.dailyCost,
      runCosts,
      resetAt: this.resetAt.toISOString(),
    };
  }
}
