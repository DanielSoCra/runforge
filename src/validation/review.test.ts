// src/validation/review.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runReview } from './review.js';
import type { Gate } from './gates.js';
import type { GateResult, ReviewFinding } from '../types.js';

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

  it('accepts maxFixCycles option without breaking', async () => {
    const gate1 = makeGate('deterministic', { gate: 'deterministic', passed: true, findings: [] });

    const result = await runReview([gate1], '/workspace', { maxFixCycles: 5 });

    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(0);
  });

  // Fix cycle tests

  it('runs fix cycle when gate fails and fixHandler succeeds, then passes', async () => {
    let callCount = 0;
    const gate1: Gate = {
      type: 'deterministic',
      execute: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { gate: 'deterministic', passed: false, findings: [{ severity: 'critical', location: 'tsc', description: 'type error' }] };
        }
        return { gate: 'deterministic', passed: true, findings: [] };
      }),
    };

    const fixHandler = vi.fn().mockResolvedValue(true);

    const result = await runReview([gate1], '/workspace', { maxFixCycles: 3, fixHandler });

    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(1);
    expect(result.escalated).toBe(false);
    expect(fixHandler).toHaveBeenCalledTimes(1);
    expect(gate1.execute).toHaveBeenCalledTimes(2);
  });

  it('re-runs ALL gates from gate 1 after a fix cycle', async () => {
    let gate2CallCount = 0;
    const gate1: Gate = {
      type: 'deterministic',
      execute: vi.fn()
        .mockResolvedValueOnce({ gate: 'deterministic', passed: false, findings: [{ severity: 'critical', location: 'tsc', description: 'err' }] })
        .mockResolvedValue({ gate: 'deterministic', passed: true, findings: [] }),
    };
    const gate2: Gate = {
      type: 'quality',
      execute: vi.fn().mockImplementation(async () => {
        gate2CallCount++;
        return { gate: 'quality', passed: true, findings: [] };
      }),
    };

    const fixHandler = vi.fn().mockResolvedValue(true);

    const result = await runReview([gate1, gate2], '/workspace', { maxFixCycles: 3, fixHandler });

    expect(result.passed).toBe(true);
    // gate2 should have been called once (only on second full run after fix)
    expect(gate2CallCount).toBe(1);
    expect(gate1.execute).toHaveBeenCalledTimes(2);
  });

  it('escalates after max fix cycles exceeded', async () => {
    const gate1 = makeGate('deterministic', {
      gate: 'deterministic',
      passed: false,
      findings: [{ severity: 'critical', location: 'tsc', description: 'persistent error' }],
    });
    const fixHandler = vi.fn().mockResolvedValue(true);

    const result = await runReview([gate1], '/workspace', { maxFixCycles: 2, fixHandler });

    expect(result.passed).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.fixCycles).toBe(2);
    // fixHandler called maxFixCycles times
    expect(fixHandler).toHaveBeenCalledTimes(2);
  });

  it('escalates immediately when fixHandler returns false', async () => {
    const gate1 = makeGate('deterministic', {
      gate: 'deterministic',
      passed: false,
      findings: [{ severity: 'critical', location: 'tsc', description: 'error' }],
    });
    const fixHandler = vi.fn().mockResolvedValue(false);

    const result = await runReview([gate1], '/workspace', { maxFixCycles: 3, fixHandler });

    expect(result.passed).toBe(false);
    expect(result.escalated).toBe(true);
    expect(fixHandler).toHaveBeenCalledTimes(1);
  });

  it('escalates immediately when no fixHandler provided on failure', async () => {
    const gate1 = makeGate('deterministic', {
      gate: 'deterministic',
      passed: false,
      findings: [{ severity: 'critical', location: 'tsc', description: 'error' }],
    });

    const result = await runReview([gate1], '/workspace', { maxFixCycles: 3 });

    expect(result.passed).toBe(false);
    expect(result.escalated).toBe(false);
    expect(result.fixCycles).toBe(0);
  });

  it('passes findings from failed gate to fixHandler', async () => {
    const findings: ReviewFinding[] = [{ severity: 'important', location: 'src/x.ts', description: 'missing check' }];
    const gate1 = makeGate('deterministic', {
      gate: 'deterministic',
      passed: false,
      findings,
    });
    const fixHandler = vi.fn().mockResolvedValue(false);

    await runReview([gate1], '/workspace', { maxFixCycles: 1, fixHandler });

    expect(fixHandler).toHaveBeenCalledWith(findings);
  });
});
