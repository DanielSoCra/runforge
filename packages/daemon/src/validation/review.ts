// src/validation/review.ts
import type { Gate } from './gates.js';
import type { GateResult, ReviewFinding } from '../types.js';

export interface ReviewResult {
  passed: boolean;
  gateResults: GateResult[];
  fixCycles: number;
  escalated: boolean;
  escalationReason?: 'max-cycles-exceeded' | 'diminishing-returns';
}

export interface DiminishingReturnsConfig {
  minCycles: number;         // default: 2 — at least this many cycles before evaluation
  improvementThreshold: number; // default: 0.2 — 20% minimum improvement required
}

export type FixHandler = (findings: ReviewFinding[]) => Promise<boolean>;

export async function runReview(
  gates: Gate[],
  cwd: string,
  options?: {
    maxFixCycles?: number;
    fixHandler?: FixHandler;
    diminishingReturns?: DiminishingReturnsConfig;
  },
): Promise<ReviewResult> {
  const maxFixCycles = options?.maxFixCycles ?? 3;
  let fixCycles = 0;
  let prevFindingCount = 0;
  let stalledCount = 0;

  while (true) {
    const gateResults: GateResult[] = [];
    let allPassed = true;

    for (const gate of gates) {
      const result = await gate.execute(cwd);
      gateResults.push(result);
      if (!result.passed) {
        allPassed = false;
        break; // stop on first failure
      }
    }

    if (allPassed) {
      return { passed: true, gateResults, fixCycles, escalated: false };
    }

    // Count findings from this cycle
    const currentFindingCount = gateResults.reduce((sum, g) => sum + g.findings.length, 0);

    // Fix cycle
    fixCycles++;
    if (fixCycles > maxFixCycles) {
      return {
        passed: false, gateResults, fixCycles: fixCycles - 1,
        escalated: true, escalationReason: 'max-cycles-exceeded',
      };
    }

    // Diminishing returns check (after minCycles)
    if (options?.diminishingReturns && fixCycles >= options.diminishingReturns.minCycles) {
      if (prevFindingCount > 0) {
        const improvement = (prevFindingCount - currentFindingCount) / prevFindingCount;
        if (improvement < options.diminishingReturns.improvementThreshold) {
          stalledCount++;
        } else {
          stalledCount = 0;
        }
        if (stalledCount >= 2) {
          return {
            passed: false, gateResults, fixCycles,
            escalated: true, escalationReason: 'diminishing-returns',
          };
        }
      }
    }
    prevFindingCount = currentFindingCount;

    if (options?.fixHandler) {
      const failedGate = gateResults.find((g) => !g.passed);
      const findings = failedGate?.findings ?? [];
      const fixed = await options.fixHandler(findings);
      if (!fixed) {
        return { passed: false, gateResults, fixCycles, escalated: true };
      }
      // Re-run all gates from the beginning
      continue;
    } else {
      // No fix handler — return failure (caller decides escalation)
      return { passed: false, gateResults, fixCycles: 0, escalated: false };
    }
  }
}
