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
}

export function createCycleRunner(
  cycleFn: () => Promise<void>,
): CycleRunner {
  let inFlight: Promise<void> | null = null;
  let shuttingDown = false;

  const wrappedCycle = async (): Promise<void> => {
    if (shuttingDown) return;
    if (inFlight) {
      log('warn', 'Previous cycle still running — skipping this interval');
      return;
    }
    try {
      inFlight = cycleFn();
      await inFlight;
    } catch (err) {
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

  return { wrappedCycle, shutdown };
}
