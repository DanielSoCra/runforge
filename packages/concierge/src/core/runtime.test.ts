import { describe, expect, it, vi } from 'vitest';
import { createInMemoryMigrationStore } from '../memory/sqlite.js';
import type { ConciergeConfig } from './config.js';
import { createConciergeRuntime, type ConciergeRuntimeClients } from './runtime.js';

const config: ConciergeConfig = {
  slackBotToken: 'xoxb-token',
  slackSigningSecret: 'secret',
  operatorSlackUserId: 'U123',
  anthropicApiKey: 'sk-test',
  modelId: 'claude-sonnet-4-6',
  tunnelHostname: 'concierge.example.com',
  boardHostname: 'board.example.com',
  vaultPath: '/vault',
  watchedRepos: ['/repo'],
  operatorEmail: 'operator@example.com',
  autoClaudeBaseUrl: 'http://127.0.0.1:3847',
};

describe('concierge runtime composition', () => {
  it('applies migrations, starts the Slack receiver, and clears lifecycle timers on stop', async () => {
    const migrationsApplied: string[] = [];
    const receiverStarts: unknown[] = [];
    const receiverStops: string[] = [];
    const intervals: Array<{ delayMs: number; callback: () => void }> = [];
    const cleared: unknown[] = [];
    const runtime = createConciergeRuntime({
      config,
      clients: clients(),
      planner: async () => ({ kind: 'none' }),
      migrations: [{
        id: '001-initial',
        up: async () => {
          migrationsApplied.push('001-initial');
        },
      }],
      migrationStore: createInMemoryMigrationStore(),
      slackReceiver: {
        start: async (handlers) => {
          receiverStarts.push(handlers);
        },
        stop: async () => {
          receiverStops.push('stopped');
        },
      },
      scheduler: {
        setInterval: (callback, delayMs) => {
          intervals.push({ callback, delayMs });
          return { id: intervals.length };
        },
        clearInterval: (handle) => cleared.push(handle),
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(migrationsApplied).toEqual(['001-initial']);
    expect(receiverStarts).toHaveLength(1);
    expect(receiverStops).toEqual(['stopped']);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.delayMs).toBe(60_000);
    expect(cleared).toEqual([{ id: 1 }]);
  });

  it('wires configured client handlers into the default tool registry', async () => {
    const slackCalls: unknown[] = [];
    const runtime = createConciergeRuntime({
      config,
      clients: clients({
        slack: {
          postMessage: async (input) => {
            slackCalls.push(input);
            return { ts: '1.2' };
          },
        },
      }),
      planner: async () => ({ kind: 'none' }),
    });

    const result = await runtime.core.router.dispatch({
      conversationId: 'c1',
      toolName: 'slack_send_dm',
      args: { text: 'hello' },
    });

    expect(result).toEqual({ status: 'completed', result: { ts: '1.2' } });
    expect(slackCalls).toEqual([{ channel: 'U123', text: 'hello' }]);
    expect(runtime.registry.get('ac_status')).toBeDefined();
    expect(runtime.registry.get('sb_write_client')?.blastRadius).toBe('high');
  });

  it('routes Slack messages into the core and posts the assistant reply to the operator', async () => {
    const slackCalls: unknown[] = [];
    const runtime = createConciergeRuntime({
      config,
      clients: clients({
        slack: {
          postMessage: async (input) => {
            slackCalls.push(input);
            return { ts: '1.3' };
          },
        },
      }),
      planner: async () => ({ kind: 'tool', toolName: 'ac_status', args: {} }),
    });

    await runtime.handleSlackMessage({
      type: 'message',
      conversationId: 'D123:111.222',
      threadTs: '111.222',
      user: 'U123',
      text: 'status?',
    });

    expect(slackCalls).toEqual([
      {
        channel: 'U123',
        text: 'ac_status completed: {"activeRuns":0,"paused":true}',
      },
    ]);
  });

  it('resolves confirmation actions through the core router and reports the outcome', async () => {
    const slackCalls: unknown[] = [];
    const runtime = createConciergeRuntime({
      config,
      clients: clients({
        slack: {
          postMessage: async (input) => {
            slackCalls.push(input);
            return { ts: '1.4' };
          },
        },
      }),
      planner: async () => ({ kind: 'none' }),
    });

    const pending = await runtime.core.router.dispatch({
      conversationId: 'c1',
      toolName: 'slack_send_channel',
      args: { channel: 'C123', text: 'public' },
    });

    expect(pending.status).toBe('pending_confirmation');
    await runtime.handleConfirmationAction({
      confirmationId: pending.status === 'pending_confirmation' ? pending.confirmationId : '',
      decision: 'approve',
    });

    expect(slackCalls).toEqual([
      { channel: 'C123', text: 'public' },
      { channel: 'U123', text: 'Confirmation approved: slack_send_channel completed.' },
    ]);
  });

  it('expires pending confirmations on demand for the lifecycle job', async () => {
    let now = 1_000;
    const runtime = createConciergeRuntime({
      config,
      clients: clients(),
      planner: async () => ({ kind: 'none' }),
      now: () => now,
      createId: vi.fn()
        .mockReturnValueOnce('tool-call-1')
        .mockReturnValueOnce('confirmation-1'),
    });

    const pending = await runtime.core.router.dispatch({
      conversationId: 'c1',
      toolName: 'mail_send',
      args: { draftId: 'd1' },
    });
    expect(pending.status).toBe('pending_confirmation');

    now += 24 * 60 * 60 * 1_000 + 1;

    expect(runtime.expireConfirmations()).toBe(1);
    expect(runtime.confirmations.get('confirmation-1')?.status).toBe('expired');
    expect(runtime.core.auditLog.get('tool-call-1')?.status).toBe('expired');
  });
});

function clients(overrides: Partial<ConciergeRuntimeClients> = {}): ConciergeRuntimeClients {
  return {
    slack: {
      postMessage: async () => ({ ts: '1.0' }),
    },
    mail: {
      draft: async (input) => ({ draftId: `${input.to}:${input.subject}` }),
      send: async (draftId) => ({ sent: true, draftId }),
    },
    github: {
      search: async (query) => ({ items: [query] }),
      comment: async (input) => ({ url: `${input.repo}#${input.number}` }),
    },
    calendar: {
      read: async () => ({ events: [] }),
    },
    observer: {
      recentActivity: async () => ({ events: [] }),
      daemonState: async () => ({ activeRuns: 0, paused: true }),
    },
    secondBrain: {
      read: async (path) => ({ path, body: 'note' }),
      search: async (query) => ({ matches: [query] }),
      appendInbox: async (input) => ({ path: `/vault/00-inbox/${input.slug}.md` }),
      writeDecision: async (path) => ({ path }),
      writeClient: async (path) => ({ path }),
    },
    autoClaude: {
      status: async () => ({ activeRuns: 0, paused: true }),
      pause: async () => ({ paused: true }),
      run: async (issue) => ({ issue, runId: `run-${issue}` }),
      unstuck: async (issue) => ({ issue, retried: true }),
    },
    web: {
      fetch: async () => new Response('hello', { status: 200 }),
    },
    ...overrides,
  };
}
