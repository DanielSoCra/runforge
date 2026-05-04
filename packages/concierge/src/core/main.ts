import { fileURLToPath } from 'node:url';
import { loadConciergeConfig, type ConciergeConfig } from './config.js';
import {
  createConciergeRuntime,
  type ConciergeRuntime,
} from './runtime.js';
import { createProcessRuntimeClients } from './process-clients.js';
import { createSlackHttpReceiver } from '../slack/http-receiver.js';

type ProcessSignal = 'SIGINT' | 'SIGTERM';

export interface StartConciergeCoreProcessOptions {
  loadConfig?: () => Promise<ConciergeConfig>;
  createRuntime?: (config: ConciergeConfig) => ConciergeRuntime;
  onSignal?: (signal: ProcessSignal, handler: () => void | Promise<void>) => void;
  logger?: Pick<Console, 'log' | 'error'>;
}

export async function startConciergeCoreProcess(
  options: StartConciergeCoreProcessOptions = {},
): Promise<ConciergeRuntime> {
  const logger = options.logger ?? console;
  const config = await (options.loadConfig ?? loadConciergeConfig)();
  const runtime = options.createRuntime
    ? options.createRuntime(config)
    : createConciergeRuntime({
      config,
      clients: createProcessRuntimeClients(config),
      planner: async () => ({ kind: 'none' }),
      slackReceiver: createSlackHttpReceiver({
        signingSecret: config.slackSigningSecret,
      }),
    });

  await runtime.start();
  logger.log('concierge-core started');

  const stop = async (): Promise<void> => {
    try {
      await runtime.stop();
      logger.log('concierge-core stopped');
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
export { createProcessRuntimeClients } from './process-clients.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startConciergeCoreProcess().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
