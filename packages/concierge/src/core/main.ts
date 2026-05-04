import { fileURLToPath } from 'node:url';
import { loadConciergeConfig, type ConciergeConfig } from './config.js';
import {
  createConciergeRuntime,
  type ConciergeRuntime,
  type ConciergeRuntimeClients,
} from './runtime.js';
import { createSlackHttpReceiver } from '../slack/http-receiver.js';

type ProcessSignal = 'SIGINT' | 'SIGTERM';

export interface StartConciergeCoreProcessOptions {
  loadConfig?: () => Promise<ConciergeConfig>;
  createRuntime?: (config: ConciergeConfig) => ConciergeRuntime;
  onSignal?: (signal: ProcessSignal, handler: () => void | Promise<void>) => void;
  logger?: Pick<Console, 'log' | 'error'>;
}

export interface ProcessRuntimeClientOptions {
  fetch?: typeof fetch;
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

export function createProcessRuntimeClients(
  config: ConciergeConfig,
  options: ProcessRuntimeClientOptions = {},
): ConciergeRuntimeClients {
  const fetchImpl = options.fetch ?? fetch;
  return {
    slack: {
      postMessage: async (input) => {
        const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.slackBotToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const body = await readJsonBody(response);
        if (!response.ok || body.ok === false) {
          throw new Error(`slack postMessage failed: ${JSON.stringify(body)}`);
        }
        return body;
      },
    },
    mail: unavailableMailClient(),
    github: unavailableGitHubClient(),
    calendar: unavailableCalendarClient(),
    observer: {
      recentActivity: async () => ({ watchedRepos: config.watchedRepos, events: [] }),
      daemonState: async () => {
        const response = await fetchImpl(`${config.autoClaudeBaseUrl.replace(/\/+$/, '')}/status`, {
          method: 'GET',
        });
        return readJsonBody(response);
      },
    },
    secondBrain: unavailableSecondBrainClient(),
    web: { fetch: (url, init) => fetchImpl(url, init) },
  };
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : { value: parsed };
}

function unavailableMailClient(): ConciergeRuntimeClients['mail'] {
  return {
    draft: async () => unavailable('mail client'),
    send: async () => unavailable('mail client'),
  };
}

function unavailableGitHubClient(): ConciergeRuntimeClients['github'] {
  return {
    search: async () => unavailable('github client'),
    comment: async () => unavailable('github client'),
  };
}

function unavailableCalendarClient(): ConciergeRuntimeClients['calendar'] {
  return {
    read: async () => unavailable('calendar client'),
  };
}

function unavailableSecondBrainClient(): ConciergeRuntimeClients['secondBrain'] {
  return {
    read: async () => unavailable('knowledge-vault client'),
    search: async () => unavailable('knowledge-vault client'),
    appendInbox: async () => unavailable('knowledge-vault client'),
    writeDecision: async () => unavailable('knowledge-vault client'),
    writeClient: async () => unavailable('knowledge-vault client'),
  };
}

function unavailable(name: string): never {
  throw new Error(`${name} is not configured for the concierge-core process`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startConciergeCoreProcess().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
