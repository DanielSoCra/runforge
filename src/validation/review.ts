// src/validation/review.ts
import type { Gate } from './gates.js';
import type { GateResult, ReviewFinding } from '../types.js';

export interface ReviewResult {
  passed: boolean;
  gateResults: GateResult[];
  fixCycles: number;
  escalated: boolean;
}

export type FixHandler = (findings: ReviewFinding[]) => Promise<boolean>;

export async function runReview(
  gates: Gate[],
  cwd: string,
  options?: { maxFixCycles?: number; fixHandler?: FixHandler },
): Promise<ReviewResult> {
  const maxFixCycles = options?.maxFixCycles ?? 3;
  let fixCycles = 0;

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

    // Fix cycle
    fixCycles++;
    if (fixCycles > maxFixCycles) {
      return { passed: false, gateResults, fixCycles: fixCycles - 1, escalated: true };
    }

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
      // No fix handler — escalate immediately
      return { passed: false, gateResults, fixCycles: 0, escalated: false };
    }
  }
}
