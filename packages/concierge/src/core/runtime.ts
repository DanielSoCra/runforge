import {
  createConfirmationStore,
  type ConfirmationRecord,
  type ConfirmationStore,
} from '../confirmation/state-machine.js';
import type { ConciergeStateDatabase } from '../memory/node-sqlite.js';
import type { Migration, MigrationStore } from '../memory/sqlite.js';
import { createConciergeStateStores, type ConciergeStateStores } from '../memory/state-stores.js';
import { runForwardOnlyMigrations } from '../memory/sqlite.js';
import type { ConfirmationAction, NormalizedSlackMessage } from '../slack/adapter.js';
import { createAutoClaudeToolHandlers, type FetchLike } from '../tools/ac.js';
import { readNumberArg } from '../tools/args.js';
import { createCalendarToolHandlers, type CalendarClient } from '../tools/cal.js';
import { createDefaultToolRegistry } from '../tools/default-tools.js';
import { createGitHubToolHandlers, type GitHubClient } from '../tools/gh.js';
import { createMailToolHandlers, type MailClient } from '../tools/mail.js';
import { createObserverToolHandlers, type ObserverClient } from '../tools/obs.js';
import { createSecondBrainToolHandlers, type SecondBrainClient } from '../tools/sb.js';
import { createSlackToolHandlers, type SlackClient } from '../tools/slack.js';
import { createWebToolHandlers } from '../tools/web.js';
import { createAuditLog } from './audit-log.js';
import { createConciergeCore, type ConciergeCore, type ConciergePlanner } from './concierge.js';
import type { ConciergeConfig } from './config.js';

export interface AutoClaudeClient {
  status(): Promise<unknown>;
  pause(): Promise<unknown>;
  run(issue: number): Promise<unknown>;
  unstuck(issue: number): Promise<unknown>;
  mergeToMain?: (issue: number) => Promise<unknown>;
}

export interface WebClient {
  fetch: FetchLike;
}

export interface ConciergeRuntimeClients {
  slack: SlackClient;
  mail: MailClient;
  github: GitHubClient;
  calendar: CalendarClient;
  observer: ObserverClient;
  secondBrain: SecondBrainClient;
  autoClaude?: AutoClaudeClient;
  web?: WebClient;
}

export interface SlackRuntimeHandlers {
  message(message: NormalizedSlackMessage): Promise<void>;
  confirmation(action: ConfirmationAction): Promise<void>;
}

export interface SlackRuntimeReceiver {
  start(handlers: SlackRuntimeHandlers): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConciergeRuntimeOptions {
  config: ConciergeConfig;
  clients: ConciergeRuntimeClients;
  planner: ConciergePlanner;
  migrations?: Migration[];
  migrationStore?: MigrationStore;
  stateDatabase?: ConciergeStateDatabase;
  slackReceiver?: SlackRuntimeReceiver;
  scheduler?: RuntimeScheduler;
  now?: () => number;
  createId?: () => string;
}

export interface ConciergeRuntime {
  config: ConciergeConfig;
  core: ConciergeCore;
  confirmations: ConfirmationStore;
  registry: ReturnType<typeof createDefaultToolRegistry>;
  state?: ConciergeStateStores;
  start(): Promise<void>;
  stop(): Promise<void>;
  handleSlackMessage(message: NormalizedSlackMessage): Promise<void>;
  handleConfirmationAction(action: ConfirmationAction): Promise<void>;
  expireConfirmations(): number;
}

const CONFIRMATION_EXPIRY_INTERVAL_MS = 60_000;
const DEFAULT_VAULT_ALLOW_LIST = ['00-inbox', '10-projects'];
const DEFAULT_VAULT_CONFIRMATION_PREFIXES = ['20-Areas/clients'];

export function createConciergeRuntime(options: ConciergeRuntimeOptions): ConciergeRuntime {
  const scheduler = options.scheduler ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const state = options.stateDatabase
    ? createConciergeStateStores(options.stateDatabase, {
      now: options.now,
      createId: options.createId,
    })
    : undefined;
  const confirmations = state?.confirmations ?? createConfirmationStore({
    now: options.now,
    createId: options.createId,
  });
  const auditLog = state?.auditLog ?? createAuditLog({
    now: options.now,
    createId: options.createId,
  });
  const registry = createDefaultToolRegistry({
    ...createConfiguredAutoClaudeHandlers(options),
    ...createWebToolHandlers({ fetch: options.clients.web?.fetch }),
    ...createSlackToolHandlers({
      operatorUserId: options.config.operatorSlackUserId,
      client: options.clients.slack,
    }),
    ...createMailToolHandlers({ client: options.clients.mail }),
    ...createGitHubToolHandlers({ client: options.clients.github }),
    ...createCalendarToolHandlers({ client: options.clients.calendar }),
    ...createObserverToolHandlers({ client: options.clients.observer }),
    ...createSecondBrainToolHandlers({
      vaultPath: options.config.vaultPath,
      allowList: DEFAULT_VAULT_ALLOW_LIST,
      confirmationRequired: DEFAULT_VAULT_CONFIRMATION_PREFIXES,
      client: options.clients.secondBrain,
    }),
  });
  const core = createConciergeCore({
    registry,
    confirmations,
    planner: options.planner,
    auditLog,
    conversations: state?.conversations,
  });
  const slackConversationIds = new Map<string, string>();
  let intervalHandle: unknown;
  let started = false;

  const runtime: ConciergeRuntime = {
    config: options.config,
    core,
    confirmations,
    registry,
    state,

    async start(): Promise<void> {
      if (started) return;
      if (options.migrations && options.migrationStore) {
        await runForwardOnlyMigrations(options.migrationStore, options.migrations);
      }
      if (options.slackReceiver) {
        await options.slackReceiver.start({
          message: runtime.handleSlackMessage,
          confirmation: runtime.handleConfirmationAction,
        });
      }
      intervalHandle = scheduler.setInterval(runtime.expireConfirmations, CONFIRMATION_EXPIRY_INTERVAL_MS);
      started = true;
    },

    async stop(): Promise<void> {
      if (!started) return;
      if (intervalHandle !== undefined) {
        scheduler.clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
      if (options.slackReceiver) {
        await options.slackReceiver.stop();
      }
      started = false;
    },

    async handleSlackMessage(message): Promise<void> {
      if (message.user !== options.config.operatorSlackUserId) return;
      const result = await core.handleOperatorMessage({
        conversationId: slackConversationIds.get(message.conversationId),
        text: message.text,
      });
      slackConversationIds.set(message.conversationId, result.conversationId);
      await options.clients.slack.postMessage({
        channel: options.config.operatorSlackUserId,
        text: result.reply,
      });
    },

    async handleConfirmationAction(action): Promise<void> {
      const confirmation = confirmations.get(action.confirmationId);
      const result = await core.router.resolveConfirmation(action.confirmationId, action.decision);
      await options.clients.slack.postMessage({
        channel: options.config.operatorSlackUserId,
        text: formatConfirmationResult(action, confirmation, result.status),
      });
    },

    expireConfirmations(): number {
      const expired = confirmations.expirePending();
      for (const record of expired) {
        core.auditLog.update(record.toolCallId, { status: 'expired' });
      }
      return expired.length;
    },
  };

  return runtime;
}

function createConfiguredAutoClaudeHandlers(
  options: ConciergeRuntimeOptions,
): ReturnType<typeof createAutoClaudeToolHandlers> {
  if (!options.clients.autoClaude) {
    return createAutoClaudeToolHandlers({
      baseUrl: options.config.autoClaudeBaseUrl,
      requestedBy: 'concierge',
    });
  }

  const client = options.clients.autoClaude;
  return {
    ac_status: async () => client.status(),
    ac_pause: async () => client.pause(),
    ac_unstuck: async (args) => client.unstuck(readNumberArg(args, 'issue')),
    ac_run: async (args) => client.run(readNumberArg(args, 'issue')),
    ac_merge_to_main: async (args) => {
      const issue = readNumberArg(args, 'issue');
      if (client.mergeToMain) return client.mergeToMain(issue);
      return {
        issue,
        status: 'confirmation-required',
        message: 'merge-to-main is intentionally left to the confirmed release path',
      };
    },
  };
}

function formatConfirmationResult(
  action: ConfirmationAction,
  confirmation: ConfirmationRecord | undefined,
  status: string,
): string {
  const toolName = confirmation?.toolName ?? action.confirmationId;
  if (action.decision === 'deny') {
    return `Confirmation denied: ${toolName} did not run.`;
  }
  if (status === 'completed') {
    return `Confirmation approved: ${toolName} completed.`;
  }
  return `Confirmation ${status}: ${toolName}.`;
}
