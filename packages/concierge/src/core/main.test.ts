import { describe, expect, it, vi } from 'vitest';
import type { ConciergeRuntime } from './runtime.js';
import { createProcessRuntimeClients, startConciergeCoreProcess } from './main.js';
import type { ConciergeConfig } from './config.js';

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

describe('concierge core process entrypoint', () => {
  it('loads config, starts the runtime, and registers shutdown handlers', async () => {
    const runtime = fakeRuntime();
    const signals: Record<string, () => void | Promise<void>> = {};

    await startConciergeCoreProcess({
      loadConfig: async () => config,
      createRuntime: (loadedConfig) => {
        expect(loadedConfig).toBe(config);
        return runtime;
      },
      onSignal: (signal, handler) => {
        signals[signal] = handler;
      },
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(runtime.start).toHaveBeenCalledOnce();
    expect(Object.keys(signals).sort()).toEqual(['SIGINT', 'SIGTERM']);

    await signals.SIGTERM?.();

    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('posts Slack messages through the Slack Web API client', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const clients = createProcessRuntimeClients(config, {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, ts: '1.2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(clients.slack.postMessage({ channel: 'U123', text: 'hello' }))
      .resolves.toEqual({ ok: true, ts: '1.2' });

    expect(requests).toEqual([
      {
        url: 'https://slack.com/api/chat.postMessage',
        init: {
          method: 'POST',
          headers: {
            Authorization: 'Bearer xoxb-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel: 'U123', text: 'hello' }),
        },
      },
    ]);
  });
});

function fakeRuntime(): ConciergeRuntime {
  return {
    config,
    core: {} as ConciergeRuntime['core'],
    confirmations: {} as ConciergeRuntime['confirmations'],
    registry: {} as ConciergeRuntime['registry'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    handleSlackMessage: vi.fn(async () => undefined),
    handleConfirmationAction: vi.fn(async () => undefined),
    expireConfirmations: vi.fn(() => 0),
  };
}
