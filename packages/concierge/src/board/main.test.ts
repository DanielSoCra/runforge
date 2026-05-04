import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConciergeConfig } from '../core/config.js';
import { openConciergeStateDatabase } from '../memory/node-sqlite.js';
import { applyConciergeStateSchemaMigrations } from '../memory/state-schema.js';
import { startConciergeBoardProcess } from './main.js';

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

describe('concierge board process entrypoint', () => {
  it('opens shared state, starts a local board server, and stops on signal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concierge-board-process-'));
    const dbPath = join(dir, 'state.db');
    const migrated = openConciergeStateDatabase(dbPath);
    await applyConciergeStateSchemaMigrations(migrated, migrated);
    migrated.close();

    const signals: Record<string, () => void | Promise<void>> = {};
    const closes: string[] = [];
    const started = await startConciergeBoardProcess({
      stateDbPath: dbPath,
      loadConfig: async () => config,
      cardActions: { invoke: vi.fn() },
      hostname: '127.0.0.1',
      port: 0,
      serve: (options) => {
        expect(options.hostname).toBe('127.0.0.1');
        expect(options.port).toBe(0);
        expect(options.fetch).toEqual(expect.any(Function));
        return {
          close: () => {
            closes.push('closed');
          },
        };
      },
      onSignal: (signal, handler) => {
        signals[signal] = handler;
      },
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(started.started).toBe(true);
    expect(Object.keys(signals).sort()).toEqual(['SIGINT', 'SIGTERM']);

    await signals.SIGTERM?.();

    expect(started.started).toBe(false);
    expect(closes).toEqual(['closed']);
  });
});
