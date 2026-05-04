import type { DaemonStatusPoller } from './daemon-poll.js';

export interface ObserverRuntimeScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConciergeObserverRuntimeOptions {
  daemonPoller: DaemonStatusPoller;
  scheduler?: ObserverRuntimeScheduler;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'error'>;
}

export interface ConciergeObserverRuntime {
  readonly started: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  pollDaemonOnce(): Promise<boolean>;
}

const DEFAULT_DAEMON_POLL_INTERVAL_MS = 30_000;

export function createConciergeObserverRuntime(
  options: ConciergeObserverRuntimeOptions,
): ConciergeObserverRuntime {
  const scheduler = options.scheduler ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const logger = options.logger ?? console;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DAEMON_POLL_INTERVAL_MS;
  let intervalHandle: unknown;
  let started = false;

  const pollDaemonOnce = async (): Promise<boolean> => {
    return options.daemonPoller.pollOnce();
  };

  return {
    get started(): boolean {
      return started;
    },

    async start(): Promise<void> {
      if (started) return;
      await pollDaemonOnce();
      intervalHandle = scheduler.setInterval(() => {
        void pollDaemonOnce().catch((error) => logger.error(error));
      }, pollIntervalMs);
      started = true;
    },

    async stop(): Promise<void> {
      if (!started) return;
      if (intervalHandle !== undefined) {
        scheduler.clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
      started = false;
    },

    pollDaemonOnce,
  };
}
