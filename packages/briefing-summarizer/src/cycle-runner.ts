/**
 * Cycle runner with concurrency guard.
 *
 * Ensures only one cycle runs at a time — if setInterval fires while a
 * previous cycle is still in flight, the new invocation is skipped.
 */

import { log } from './log.js';

export interface CycleRunner {
  wrappedCycle: () => Promise<void>;
  shutdown: (signal: string) => Promise<void>;
  getStatus: () => CycleRunnerStatus;
}

export interface CycleRunnerStatus {
  inFlight: boolean;
  shuttingDown: boolean;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
}

export function createCycleRunner(
  cycleFn: () => Promise<void>,
): CycleRunner {
  let inFlight: Promise<void> | null = null;
  let shuttingDown = false;
  let lastStartedAt: number | null = null;
  let lastCompletedAt: number | null = null;
  let lastFailedAt: number | null = null;

  const wrappedCycle = async (): Promise<void> => {
    if (shuttingDown) return;
    if (inFlight) {
      log('warn', 'Previous cycle still running — skipping this interval');
      return;
    }
    try {
      lastStartedAt = Date.now();
      inFlight = cycleFn();
      await inFlight;
      lastCompletedAt = Date.now();
    } catch (err) {
      lastFailedAt = Date.now();
      log('error', `Cycle failed: ${String(err)}`);
    } finally {
      inFlight = null;
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `Received ${signal}, shutting down gracefully...`);

    if (inFlight) {
      log('info', 'Waiting for in-flight cycle to complete...');
      try {
        await inFlight;
      } catch {
        // Already logged in wrappedCycle
      }
    }

    log('info', 'Shutdown complete');
  };

  const getStatus = (): CycleRunnerStatus => ({
    inFlight: inFlight !== null,
    shuttingDown,
    lastStartedAt,
    lastCompletedAt,
    lastFailedAt,
  });

  return { wrappedCycle, shutdown, getStatus };
}
