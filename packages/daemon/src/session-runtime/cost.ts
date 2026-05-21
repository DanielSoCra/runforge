// src/session-runtime/cost.ts

export type BudgetCheck =
  | { available: true; remaining: number }
  | {
      available: false;
      reason: 'daily-budget-exceeded' | 'per-run-budget-exceeded';
    };

export interface CostSnapshot {
  dailyCost: number;
  runCosts: Record<string, number>;
  resetAt: string;
}

export interface CostReservation {
  readonly id: number;
}

type MutableCostReservation = {
  issueNumbers: number[];
  remainingTotal: number;
};

export type CostReservationResult =
  | { reserved: true; reservation: CostReservation }
  | {
      reserved: false;
      reason: 'daily-budget-exceeded' | 'per-run-budget-exceeded';
    };

export class CostTracker {
  private dailyCost = 0;
  private runCosts = new Map<number, number>();
  private reservedDailyCost = 0;
  private reservedRunCosts = new Map<number, number>();
  private reservations = new Map<number, MutableCostReservation>();
  private nextReservationId = 1;
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

  checkBudget(
    issueNumber: number,
    perRunBudgetOverride?: number,
    options?: { excludeReservation?: CostReservation },
  ): BudgetCheck {
    const excluded = this.lookupReservation(options?.excludeReservation);
    const effectiveReservedDaily = Math.max(
      0,
      this.reservedDailyCost - (excluded?.remainingTotal ?? 0),
    );
    if (this.dailyCost + effectiveReservedDaily >= this.dailyBudget) {
      return { available: false, reason: 'daily-budget-exceeded' };
    }
    const effectiveBudget = perRunBudgetOverride ?? this.perRunBudget;
    const excludedRunReservation =
      excluded && excluded.issueNumbers.includes(issueNumber)
        ? excluded.remainingTotal / excluded.issueNumbers.length
        : 0;
    const effectiveReservedRun = Math.max(
      0,
      (this.reservedRunCosts.get(issueNumber) ?? 0) - excludedRunReservation,
    );
    if (
      this.getRunCost(issueNumber) + effectiveReservedRun >=
      effectiveBudget
    ) {
      return { available: false, reason: 'per-run-budget-exceeded' };
    }
    return {
      available: true,
      remaining: this.dailyBudget - this.dailyCost - effectiveReservedDaily,
    };
  }

  recordCost(issueNumber: number, cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) return;
    this.dailyCost += cost;
    this.runCosts.set(issueNumber, this.getRunCost(issueNumber) + cost);
  }

  reserveCost(
    issueNumbers: number[],
    totalCost: number,
    perRunBudgetOverride?: number,
  ): CostReservationResult {
    const normalizedIssueNumbers = [
      ...new Set(
        issueNumbers.filter(
          (issueNumber) => Number.isInteger(issueNumber) && issueNumber > 0,
        ),
      ),
    ];
    if (normalizedIssueNumbers.length === 0) {
      return { reserved: false, reason: 'per-run-budget-exceeded' };
    }

    const normalizedTotalCost =
      Number.isFinite(totalCost) && totalCost > 0 ? totalCost : 0;
    const perIssueReservation =
      normalizedTotalCost / normalizedIssueNumbers.length;
    if (
      this.dailyCost + this.reservedDailyCost + normalizedTotalCost >
      this.dailyBudget
    ) {
      return { reserved: false, reason: 'daily-budget-exceeded' };
    }

    const effectiveBudget = perRunBudgetOverride ?? this.perRunBudget;
    for (const issueNumber of normalizedIssueNumbers) {
      const projectedRunCost =
        this.getRunCost(issueNumber) +
        (this.reservedRunCosts.get(issueNumber) ?? 0) +
        perIssueReservation;
      if (projectedRunCost > effectiveBudget) {
        return { reserved: false, reason: 'per-run-budget-exceeded' };
      }
    }

    const reservation = { id: this.nextReservationId++ };
    this.reservations.set(reservation.id, {
      issueNumbers: normalizedIssueNumbers,
      remainingTotal: normalizedTotalCost,
    });
    this.reservedDailyCost += normalizedTotalCost;
    for (const issueNumber of normalizedIssueNumbers) {
      this.reservedRunCosts.set(
        issueNumber,
        (this.reservedRunCosts.get(issueNumber) ?? 0) + perIssueReservation,
      );
    }

    return { reserved: true, reservation };
  }

  recordReservedCost(reservation: CostReservation, cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) return;

    const active = this.lookupReservation(reservation);
    if (!active) {
      return;
    }

    const releasedReservation = Math.min(active.remainingTotal, cost);
    if (releasedReservation > 0) {
      this.releaseReservedAmount(active, releasedReservation);
    }

    const actualCostPerIssue = cost / active.issueNumbers.length;
    for (const issueNumber of active.issueNumbers) {
      this.recordCost(issueNumber, actualCostPerIssue);
    }
  }

  releaseCostReservation(reservation: CostReservation): void {
    const active = this.lookupReservation(reservation);
    if (!active) return;

    this.releaseReservedAmount(active, active.remainingTotal);
    this.reservations.delete(reservation.id);
  }

  /** Automated daily-boundary reset: clears both daily total and per-run costs so stale run costs don't permanently block issues across days. */
  maybeResetDaily(): boolean {
    if (Date.now() >= this.resetAt.getTime()) {
      this.dailyCost = 0;
      this.runCosts.clear();
      this.resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      return true;
    }
    return false;
  }

  /** Manual reset: clears daily total only, preserving per-run costs for continued tracking. */
  resetDaily(): void {
    this.dailyCost = 0;
    this.resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  restoreFromSnapshot(snapshot: CostSnapshot): void {
    this.dailyCost =
      Number.isFinite(snapshot.dailyCost) && snapshot.dailyCost >= 0
        ? snapshot.dailyCost
        : 0;
    this.resetAt = new Date(snapshot.resetAt);
    this.runCosts.clear();
    this.reservedDailyCost = 0;
    this.reservedRunCosts.clear();
    this.reservations.clear();
    for (const [k, v] of Object.entries(snapshot.runCosts)) {
      this.runCosts.set(Number(k), Number.isFinite(v) && v >= 0 ? v : 0);
    }
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

  private lookupReservation(
    reservation: CostReservation | undefined,
  ): MutableCostReservation | undefined {
    if (!reservation) return undefined;
    return this.reservations.get(reservation.id);
  }

  private releaseReservedAmount(
    reservation: MutableCostReservation,
    amount: number,
  ): void {
    if (amount <= 0 || reservation.remainingTotal <= 0) return;

    const releasedAmount = Math.min(amount, reservation.remainingTotal);
    const releasedPerIssue = releasedAmount / reservation.issueNumbers.length;
    this.reservedDailyCost = Math.max(
      0,
      this.reservedDailyCost - releasedAmount,
    );
    reservation.remainingTotal = Math.max(
      0,
      reservation.remainingTotal - releasedAmount,
    );

    for (const issueNumber of reservation.issueNumbers) {
      const nextReservedCost = Math.max(
        0,
        (this.reservedRunCosts.get(issueNumber) ?? 0) - releasedPerIssue,
      );
      if (nextReservedCost === 0) {
        this.reservedRunCosts.delete(issueNumber);
      } else {
        this.reservedRunCosts.set(issueNumber, nextReservedCost);
      }
    }
  }
}
