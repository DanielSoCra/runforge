import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCycleRunner } from './cycle-runner.js';

// Mock the log module to suppress output and allow assertions
vi.mock('./log.js', () => ({
  log: vi.fn(),
}));

import { log } from './log.js';

describe('createCycleRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a cycle to completion', async () => {
    const cycleFn = vi.fn().mockResolvedValue(undefined);
    const runner = createCycleRunner(cycleFn);

    await runner.wrappedCycle();

    expect(cycleFn).toHaveBeenCalledTimes(1);
  });

  it('skips overlapping cycles when previous is still running', async () => {
    // Create a cycle that blocks until we resolve it
    let resolveFirst!: () => void;
    const firstCyclePromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const cycleFn = vi.fn().mockReturnValueOnce(firstCyclePromise).mockResolvedValue(undefined);
    const runner = createCycleRunner(cycleFn);

    // Start first cycle (don't await — it's deliberately blocking)
    const firstRun = runner.wrappedCycle();

    // Attempt a second cycle while first is in flight
    await runner.wrappedCycle();

    // cycleFn should have been called only once — second call was skipped
    expect(cycleFn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'Previous cycle still running — skipping this interval');

    // Complete the first cycle
    resolveFirst();
    await firstRun;
  });

  it('allows a new cycle after previous completes', async () => {
    const cycleFn = vi.fn().mockResolvedValue(undefined);
    const runner = createCycleRunner(cycleFn);

    await runner.wrappedCycle();
    await runner.wrappedCycle();

    expect(cycleFn).toHaveBeenCalledTimes(2);
  });

  it('clears inFlight even when cycle throws', async () => {
    const cycleFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const runner = createCycleRunner(cycleFn);

    // First cycle fails
    await runner.wrappedCycle();
    expect(log).toHaveBeenCalledWith('error', 'Cycle failed: Error: boom');

    // Second cycle should still run (inFlight was cleared in finally)
    await runner.wrappedCycle();
    expect(cycleFn).toHaveBeenCalledTimes(2);
  });

  it('skips cycles after shutdown', async () => {
    const cycleFn = vi.fn().mockResolvedValue(undefined);
    const runner = createCycleRunner(cycleFn);

    await runner.shutdown('SIGTERM');
    await runner.wrappedCycle();

    expect(cycleFn).not.toHaveBeenCalled();
  });
});
