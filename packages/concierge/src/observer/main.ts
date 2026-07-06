import { fileURLToPath } from 'node:url';
import { loadConciergeConfig, type ConciergeConfig } from '../core/config.js';
import {
  defaultConciergeStateDbPath,
  openConciergeStateDatabase,
  type ConciergeStateDatabase,
} from '../memory/node-sqlite.js';
import { createConciergeStateStores } from '../memory/state-stores.js';
import { createDaemonStatusHttpClient, createDaemonStatusPoller } from './daemon-poll.js';
import {
  createGitRepoActivityClient,
  createRepoActivityPoller,
  type RepoActivityExecFile,
} from './repo-activity.js';
import {
  createConciergeObserverRuntime,
  type ConciergeObserverRuntime,
  type ObserverRuntimeScheduler,
} from './runtime.js';

type ProcessSignal = 'SIGINT' | 'SIGTERM';

export interface StartConciergeObserverProcessOptions {
  loadConfig?: () => Promise<ConciergeConfig>;
  stateDbPath?: string;
  openStateDatabase?: (path: string) => ConciergeStateDatabase;
  fetch?: typeof fetch;
  scheduler?: ObserverRuntimeScheduler;
  pollIntervalMs?: number;
  repoPollIntervalMs?: number;
  execFile?: RepoActivityExecFile;
  onSignal?: (signal: ProcessSignal, handler: () => void | Promise<void>) => void;
  logger?: Pick<Console, 'log' | 'error'>;
}

export async function startConciergeObserverProcess(
  options: StartConciergeObserverProcessOptions = {},
): Promise<ConciergeObserverRuntime> {
  const logger = options.logger ?? console;
  const config = await (options.loadConfig ?? loadConciergeConfig)();
  const path = options.stateDbPath ?? defaultConciergeStateDbPath();
  const stateDb = (options.openStateDatabase ?? openConciergeStateDatabase)(path);
  assertObserverSchemaReady(stateDb);
  const stores = createConciergeStateStores(stateDb);
  const runtime = createConciergeObserverRuntime({
    daemonPoller: createDaemonStatusPoller({
      events: stores.events,
      client: createDaemonStatusHttpClient({
        baseUrl: config.runforgeBaseUrl,
        fetch: options.fetch,
      }),
    }),
    repoActivityPoller: createRepoActivityPoller({
      events: stores.events,
      watchedRepos: config.watchedRepos,
      client: createGitRepoActivityClient({
        execFile: options.execFile,
      }),
    }),
    scheduler: options.scheduler,
    pollIntervalMs: options.pollIntervalMs,
    repoPollIntervalMs: options.repoPollIntervalMs,
    logger,
  });

  await runtime.start();
  logger.log('concierge-observer started');

  const stop = async (): Promise<void> => {
    try {
      await runtime.stop();
      stateDb.close();
      logger.log('concierge-observer stopped');
    } catch (error) {
      logger.error(error);
    }
  };
  const onSignal = options.onSignal ?? ((signal, handler) => {
    process.on(signal, () => {
      void handler();
    });
  });
  onSignal('SIGINT', stop);
  onSignal('SIGTERM', stop);

  return runtime;
}

function assertObserverSchemaReady(stateDb: ConciergeStateDatabase): void {
  const tables = new Set(stateDb.tableNames());
  if (!tables.has('events')) {
    throw new Error('concierge state schema is not ready: events table missing');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startConciergeObserverProcess().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
