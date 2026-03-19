// src/validation/review.ts
import type { Gate } from './gates.js';
import type { GateResult } from '../types.js';

export interface ReviewResult {
  passed: boolean;
  gateResults: GateResult[];
  fixCycles: number;
  escalated: boolean;
}

export async function runReview(
  gates: Gate[],
  cwd: string,
  maxFixCycles: number = 3,
): Promise<ReviewResult> {
  const gateResults: GateResult[] = [];

  for (const gate of gates) {
    const result = await gate.execute(cwd);
    gateResults.push(result);
    if (!result.passed) {
      // For MVP: no fix cycle, just return failure
      return { passed: false, gateResults, fixCycles: 0, escalated: false };
    }
  }

  return { passed: true, gateResults, fixCycles: 0, escalated: false };
}
