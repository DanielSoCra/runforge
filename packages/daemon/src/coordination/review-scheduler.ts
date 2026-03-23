// src/coordination/review-scheduler.ts — Periodic codebase review scheduler with signal-ratio throttling
//
// Follows the po-agent.ts pattern: configurable interval, setInterval-based scheduling,
// category rotation across review cycles.

export type ReviewCategory = 'correctness' | 'consistency' | 'security' | 'performance' | 'test-gaps';

const CATEGORIES: ReviewCategory[] = [
  'correctness',
  'consistency',
  'security',
  'performance',
  'test-gaps',
];

export interface ReviewSchedulerConfig {
  intervalMs: number;            // base interval between cycles (default 20 min)
  signalRatioThreshold: number;  // if verified/closed < this, double interval
  maxIssuesPerCycle: number;     // max issues created per cycle (default 5)
}

export interface ReviewCycleResult {
  findingsCount: number;
  issuesCreated: number;
}

export interface ReviewSchedulerDeps {
  /** Spawn a review session for the given category. Returns cycle result. */
  spawnReviewSession: (category: ReviewCategory) => Promise<ReviewCycleResult>;
  /** Returns the signal ratio: verified issues / total closed review issues. 1.0 = perfect signal. */
  getSignalRatio: () => number;
}

export interface ReviewSchedulerStatus {
  currentIntervalMs: number;
  cyclesRun: number;
  nextCategory: ReviewCategory;
  throttled: boolean;
}

export interface ReviewScheduler {
  start(): () => void;
  getStatus(): ReviewSchedulerStatus;
}

export function createReviewScheduler(
  deps: ReviewSchedulerDeps,
  config: ReviewSchedulerConfig,
): ReviewScheduler {
  let cyclesRun = 0;
  let currentIntervalMs = config.intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function nextCategory(): ReviewCategory {
    return CATEGORIES[cyclesRun % CATEGORIES.length]!;
  }

  async function runCycle(): Promise<void> {
    if (running) return; // prevent concurrent sessions
    running = true;

    try {
      const category = nextCategory();
      await deps.spawnReviewSession(category);
      cyclesRun++;

      // Check signal ratio and adjust interval
      const ratio = deps.getSignalRatio();
      if (ratio < config.signalRatioThreshold) {
        currentIntervalMs = config.intervalMs * 2;
      } else {
        currentIntervalMs = config.intervalMs;
      }
    } catch (e) {
      console.error('[review-scheduler] cycle error:', e);
      cyclesRun++;
    } finally {
      running = false;
      // Schedule next tick with potentially updated interval
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    if (timer === null) return; // stopped
    timer = setTimeout(() => {
      runCycle().catch((e) => {
        console.error('[review-scheduler] unexpected error:', e);
      });
    }, currentIntervalMs);
  }

  function start(): () => void {
    // Use a sentinel non-null value so scheduleNext knows we're active
    timer = setTimeout(() => {
      runCycle().catch((e) => {
        console.error('[review-scheduler] unexpected error:', e);
      });
    }, currentIntervalMs);

    return () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  function getStatus(): ReviewSchedulerStatus {
    return {
      currentIntervalMs,
      cyclesRun,
      nextCategory: nextCategory(),
      throttled: currentIntervalMs > config.intervalMs,
    };
  }

  return { start, getStatus };
}
