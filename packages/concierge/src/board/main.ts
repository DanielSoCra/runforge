import { serve as honoServe } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { loadConciergeConfig, type ConciergeConfig } from '../core/config.js';
import {
  defaultConciergeStateDbPath,
  openConciergeStateDatabase,
  type ConciergeStateDatabase,
} from '../memory/node-sqlite.js';
import { createConciergeStateStores } from '../memory/state-stores.js';
import {
  createConciergeBoardApp,
  createCoreCardActionClient,
  type BoardCardActionClient,
} from './server.js';

type ProcessSignal = 'SIGINT' | 'SIGTERM';

export interface BoardServeOptions {
  fetch: (request: Request) => Response | Promise<Response>;
  hostname: string;
  port: number;
}

export interface BoardServerHandle {
  close(): void | Promise<void>;
}

export type BoardServe = (options: BoardServeOptions) => BoardServerHandle;

export interface ConciergeBoardProcess {
  readonly started: boolean;
  stop(): Promise<void>;
}

export interface StartConciergeBoardProcessOptions {
  loadConfig?: () => Promise<ConciergeConfig>;
  stateDbPath?: string;
  openStateDatabase?: (path: string) => ConciergeStateDatabase;
  hostname?: string;
  port?: number;
  serve?: BoardServe;
  onSignal?: (signal: ProcessSignal, handler: () => void | Promise<void>) => void;
  logger?: Pick<Console, 'log' | 'error'>;
  cardActions?: BoardCardActionClient;
  coreBaseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BOARD_HOSTNAME = '127.0.0.1';
const DEFAULT_BOARD_PORT = 3849;

export async function startConciergeBoardProcess(
  options: StartConciergeBoardProcessOptions = {},
): Promise<ConciergeBoardProcess> {
  const logger = options.logger ?? console;
  await (options.loadConfig ?? loadConciergeConfig)();
  const stateDb = (options.openStateDatabase ?? openConciergeStateDatabase)(
    options.stateDbPath ?? defaultConciergeStateDbPath(),
  );
  assertBoardSchemaReady(stateDb);
  const stores = createConciergeStateStores(stateDb);
  const app = createConciergeBoardApp({
    cards: stores.cards,
    events: stores.events,
    actions: options.cardActions ?? createCoreCardActionClient({
      baseUrl: options.coreBaseUrl,
      fetch: options.fetch,
    }),
  });
  const serve = options.serve ?? defaultServe;
  const server = serve({
    fetch: app.fetch,
    hostname: options.hostname ?? DEFAULT_BOARD_HOSTNAME,
    port: options.port ?? DEFAULT_BOARD_PORT,
  });
  let started = true;

  const processHandle: ConciergeBoardProcess = {
    get started(): boolean {
      return started;
    },

    async stop(): Promise<void> {
      if (!started) return;
      await server.close();
      stateDb.close();
      started = false;
      logger.log('concierge-board stopped');
    },
  };

  const onSignal = options.onSignal ?? ((signal, handler) => {
    process.on(signal, () => {
      void handler();
    });
  });
  onSignal('SIGINT', processHandle.stop);
  onSignal('SIGTERM', processHandle.stop);
  logger.log('concierge-board started');

  return processHandle;
}

function assertBoardSchemaReady(stateDb: ConciergeStateDatabase): void {
  const tables = new Set(stateDb.tableNames());
  for (const table of ['cards', 'events']) {
    if (!tables.has(table)) {
      throw new Error(`concierge state schema is not ready: ${table} table missing`);
    }
  }
}

const defaultServe: BoardServe = (options) => {
  const server = honoServe(options);
  return {
    close: () => {
      server.close();
    },
  };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startConciergeBoardProcess().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
