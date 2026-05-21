import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConciergeConfig } from '../core/config.js';
import { openConciergeStateDatabase } from '../memory/node-sqlite.js';
import { applyConciergeStateSchemaMigrations } from '../memory/state-schema.js';
import { createConciergeStateStores } from '../memory/state-stores.js';
import { startConciergeObserverProcess } from './main.js';

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
  autoClaudeBaseUrl: 'http://daemon.local',
};

describe('concierge observer process entrypoint', () => {
  it('opens the shared state database, starts daemon polling, and stops cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concierge-observer-'));
    const dbPath = join(dir, 'state.db');
    const migrated = openConciergeStateDatabase(dbPath);
    await applyConciergeStateSchemaMigrations(migrated, migrated);
    migrated.close();

    const intervals: Array<{ callback: () => void; delayMs: number }> = [];
    const cleared: unknown[] = [];
    const signals: Record<string, () => void | Promise<void>> = {};
    const runtime = await startConciergeObserverProcess({
      stateDbPath: dbPath,
      loadConfig: async () => config,
      fetch: async (url) => {
        expect(String(url)).toBe('http://daemon.local/status');
        return new Response(JSON.stringify({ paused: true, activeRuns: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      execFile: async (file, args) => {
        expect(file).toBe('git');
        expect(args).toEqual([
          '-C',
          '/repo',
          'for-each-ref',
          '--format=%(refname:short)%00%(objectname)',
          'refs/heads',
        ]);
        return { stdout: 'dev\u0000aaa111\n' };
      },
      scheduler: {
        setInterval: (callback, delayMs) => {
          intervals.push({ callback, delayMs });
          return { id: `interval-${intervals.length}` };
        },
        clearInterval: (handle) => cleared.push(handle),
      },
      onSignal: (signal, handler) => {
        signals[signal] = handler;
      },
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(intervals).toEqual([
      { callback: expect.any(Function), delayMs: 30_000 },
      { callback: expect.any(Function), delayMs: 30_000 },
    ]);
    expect(Object.keys(signals).sort()).toEqual(['SIGINT', 'SIGTERM']);

    await signals.SIGTERM?.();
    expect(cleared).toEqual([{ id: 'interval-2' }, { id: 'interval-1' }]);

    const reopened = openConciergeStateDatabase(dbPath);
    expect(createConciergeStateStores(reopened).events.list()).toEqual([
      expect.objectContaining({
        source: 'observer',
        type: 'daemon_paused',
        payload: { paused: true, activeRuns: 0 },
      }),
    ]);
    reopened.close();
    expect(runtime.started).toBe(false);
  });
});
