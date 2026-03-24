// src/coordination/review-scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReviewScheduler, type ReviewSchedulerDeps, type ReviewSchedulerConfig } from './review-scheduler.js';

function makeConfig(overrides: Partial<ReviewSchedulerConfig> = {}): ReviewSchedulerConfig {
  return {
    intervalMs: 20 * 60 * 1000, // 20 minutes
    signalRatioThreshold: 0.6,
    maxIssuesPerCycle: 5,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReviewSchedulerDeps> = {}): ReviewSchedulerDeps {
  return {
    spawnReviewSession: vi.fn().mockResolvedValue({ findingsCount: 2, issuesCreated: 1 }),
    getSignalRatio: vi.fn().mockReturnValue(1.0), // 100% signal — no throttling
    ...overrides,
  };
}

describe('ReviewScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns review session on configured interval', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1);
    stop();
  });

  it('passes rotating category to each cycle', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    // Run 5 cycles to see all categories
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1100);
    }

    const calls = (deps.spawnReviewSession as ReturnType<typeof vi.fn>).mock.calls;
    const categories = calls.map((c) => c[0]);
    expect(categories).toEqual([
      'correctness',
      'consistency',
      'security',
      'performance',
      'test-gaps',
    ]);
    stop();
  });

  it('rotates categories cyclically after exhausting all', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    // Run 6 cycles — should wrap back to first category
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1100);
    }

    const calls = (deps.spawnReviewSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[5]![0]).toBe('correctness'); // wraps around
    stop();
  });

  it('doubles interval when signal ratio drops below threshold', async () => {
    const deps = makeDeps({
      getSignalRatio: vi.fn().mockReturnValue(0.5), // below 0.6 threshold
    });
    const config = makeConfig({ intervalMs: 1000, signalRatioThreshold: 0.6 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    // First tick at 1s — should spawn but detect low signal ratio
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1);

    // At 2.1s — normal interval would have fired again, but throttled interval is 2s
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1); // still 1

    // At 3.2s — throttled interval fires
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(2);

    stop();
  });

  it('restores original interval when signal ratio recovers', async () => {
    let signalRatio = 0.5;
    const deps = makeDeps({
      getSignalRatio: vi.fn().mockImplementation(() => signalRatio),
    });
    const config = makeConfig({ intervalMs: 1000, signalRatioThreshold: 0.6 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    // First tick — low ratio, doubles interval
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1);

    // Signal recovers
    signalRatio = 0.8;

    // Wait for doubled interval (2s)
    await vi.advanceTimersByTimeAsync(2100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(2);

    // Now back to original interval (1s) since ratio recovered
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(3);

    stop();
  });

  it('stop() prevents further cycles', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    stop();

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.spawnReviewSession).not.toHaveBeenCalled();
  });

  it('handles spawnReviewSession errors gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      spawnReviewSession: vi.fn().mockRejectedValue(new Error('spawn failed')),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    await vi.advanceTimersByTimeAsync(1100);

    // Should not throw — error is caught and logged
    expect(consoleSpy).toHaveBeenCalled();
    stop();
    consoleSpy.mockRestore();
  });

  it('does not spawn concurrent review sessions', async () => {
    let resolveSpawn: (() => void) | null = null;
    const deps = makeDeps({
      spawnReviewSession: vi.fn().mockImplementation(() => {
        return new Promise<{ findingsCount: number; issuesCreated: number }>((resolve) => {
          resolveSpawn = () => resolve({ findingsCount: 0, issuesCreated: 0 });
        });
      }),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    // First tick starts a session
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1);

    // Second tick fires while first is still running
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1); // still 1 — skipped

    // Resolve the first session
    resolveSpawn!();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Third tick should now spawn
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(2);

    stop();
  });

  it('skips cycle when signal ratio is zero', async () => {
    const deps = makeDeps({
      getSignalRatio: vi.fn().mockReturnValue(0), // no signal at all
    });
    const config = makeConfig({ intervalMs: 1000, signalRatioThreshold: 0.6 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    // First tick — should still run (even with zero ratio, we run but double interval)
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.spawnReviewSession).toHaveBeenCalledTimes(1);

    stop();
  });

  it('getStatus returns current scheduler state', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const scheduler = createReviewScheduler(deps, config);
    const stop = scheduler.start();

    const status = scheduler.getStatus();
    expect(status).toHaveProperty('currentIntervalMs');
    expect(status).toHaveProperty('cyclesRun');
    expect(status).toHaveProperty('nextCategory');
    expect(status.cyclesRun).toBe(0);
    expect(status.currentIntervalMs).toBe(1000);
    expect(status.nextCategory).toBe('correctness');

    await vi.advanceTimersByTimeAsync(1100);

    const status2 = scheduler.getStatus();
    expect(status2.cyclesRun).toBe(1);
    expect(status2.nextCategory).toBe('consistency');

    stop();
  });
});
