import type { DaemonStatusPoller } from './daemon-poll.js';
import type { RepoActivityPoller } from './repo-activity.js';

export interface ObserverRuntimeScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConciergeObserverRuntimeOptions {
  daemonPoller: DaemonStatusPoller;
  repoActivityPoller?: RepoActivityPoller;
  scheduler?: ObserverRuntimeScheduler;
  pollIntervalMs?: number;
  repoPollIntervalMs?: number;
  logger?: Pick<Console, 'error'>;
}

export interface ConciergeObserverRuntime {
  readonly started: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  pollDaemonOnce(): Promise<boolean>;
  pollRepoActivityOnce(): Promise<boolean>;
}

const DEFAULT_DAEMON_POLL_INTERVAL_MS = 30_000;
const DEFAULT_REPO_POLL_INTERVAL_MS = 30_000;

export function createConciergeObserverRuntime(
  options: ConciergeObserverRuntimeOptions,
): ConciergeObserverRuntime {
  const scheduler = options.scheduler ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const logger = options.logger ?? console;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DAEMON_POLL_INTERVAL_MS;
  const repoPollIntervalMs = options.repoPollIntervalMs ?? DEFAULT_REPO_POLL_INTERVAL_MS;
  const intervalHandles: unknown[] = [];
  let started = false;

  const pollDaemonOnce = async (): Promise<boolean> => {
    return options.daemonPoller.pollOnce();
  };

  const pollRepoActivityOnce = async (): Promise<boolean> => {
    if (!options.repoActivityPoller) return false;
    return options.repoActivityPoller.pollOnce();
  };

  return {
    get started(): boolean {
      return started;
    },

    async start(): Promise<void> {
      if (started) return;
      await pollDaemonOnce();
      await pollRepoActivityOnce();
      intervalHandles.push(scheduler.setInterval(() => {
        void pollDaemonOnce().catch((error) => logger.error(error));
      }, pollIntervalMs));
      if (options.repoActivityPoller) {
        intervalHandles.push(scheduler.setInterval(() => {
          void pollRepoActivityOnce().catch((error) => logger.error(error));
        }, repoPollIntervalMs));
      }
      started = true;
    },

    async stop(): Promise<void> {
      if (!started) return;
      while (intervalHandles.length > 0) {
        scheduler.clearInterval(intervalHandles.pop());
      }
      started = false;
    },

    pollDaemonOnce,
    pollRepoActivityOnce,
  };
}
