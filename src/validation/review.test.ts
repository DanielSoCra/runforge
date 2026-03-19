// src/validation/review.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runReview } from './review.js';
import type { Gate } from './gates.js';
import type { GateResult } from '../types.js';

function makeGate(type: 'deterministic' | 'spec-compliance' | 'quality' | 'security', result: GateResult): Gate {
  return {
    type,
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe('runReview', () => {
  it('passes when all gates pass', async () => {
    const gate1 = makeGate('deterministic', { gate: 'deterministic', passed: true, findings: [] });
    const gate2 = makeGate('quality', { gate: 'quality', passed: true, findings: [] });

    const result = await runReview([gate1, gate2], '/workspace');

    expect(result.passed).toBe(true);
    expect(result.gateResults).toHaveLength(2);
    expect(result.escalated).toBe(false);
    expect(result.fixCycles).toBe(0);
  });

  it('fails and stops on first gate failure', async () => {
    const gate1 = makeGate('deterministic', {
      gate: 'deterministic',
      passed: false,
      findings: [{ severity: 'critical', location: 'tsc', description: 'type error' }],
    });
    const gate2 = makeGate('quality', { gate: 'quality', passed: true, findings: [] });

    const result = await runReview([gate1, gate2], '/workspace');

    expect(result.passed).toBe(false);
    expect(result.gateResults).toHaveLength(1);
    // gate2 should not have been executed
    expect(gate2.execute).not.toHaveBeenCalled();
  });

  it('returns all gate results when all gates pass', async () => {
    const gate1 = makeGate('deterministic', { gate: 'deterministic', passed: true, findings: [] });
    const gate2 = makeGate('spec-compliance', { gate: 'spec-compliance', passed: true, findings: [] });
    const gate3 = makeGate('security', { gate: 'security', passed: true, findings: [] });

    const result = await runReview([gate1, gate2, gate3], '/workspace');

    expect(result.gateResults).toHaveLength(3);
    expect(result.gateResults[0]?.gate).toBe('deterministic');
    expect(result.gateResults[1]?.gate).toBe('spec-compliance');
    expect(result.gateResults[2]?.gate).toBe('security');
  });

  it('passes with no gates', async () => {
    const result = await runReview([], '/workspace');

    expect(result.passed).toBe(true);
    expect(result.gateResults).toHaveLength(0);
  });

  it('includes the failed gate result in gateResults', async () => {
    const failedGateResult: GateResult = {
      gate: 'deterministic',
      passed: false,
      findings: [{ severity: 'critical', location: 'tsc', description: 'type error' }],
    };
    const gate1 = makeGate('deterministic', failedGateResult);

    const result = await runReview([gate1], '/workspace');

    expect(result.gateResults[0]).toEqual(failedGateResult);
  });

  it('accepts maxFixCycles parameter without breaking', async () => {
    const gate1 = makeGate('deterministic', { gate: 'deterministic', passed: true, findings: [] });

    const result = await runReview([gate1], '/workspace', 5);

    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(0);
  });
});
