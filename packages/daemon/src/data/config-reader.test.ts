import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresConfigReader } from './config-reader.js';

function makeStores(overrides?: {
  settings?: unknown;
  repos?: unknown;
  plugins?: unknown;
}) {
  return {
    settings: {
      readGlobalSettings:
        overrides?.settings ??
        vi.fn().mockResolvedValue({
          ok: true,
          value: {
            concurrencyLimit: 3,
            dailyBudgetLimit: 100,
            defaultModel: 'claude-sonnet-4-6',
          },
        }),
    },
    repos: {
      listEnabledRepositories:
        overrides?.repos ??
        vi.fn().mockResolvedValue({
          ok: true,
          value: [
            {
              id: 'repo-1',
              owner: 'org',
              name: 'repo',
              budgetLimit: 10,
              concurrencyLimit: 2,
            },
          ],
        }),
    },
    plugins: {
      listActivePlugins:
        overrides?.plugins ??
        vi.fn().mockResolvedValue({
          ok: true,
          value: [
            {
              pluginId: 'plugin-a',
              activatedAt: new Date('2026-05-20T10:00:00Z'),
            },
          ],
        }),
    },
  };
}

describe('PostgresConfigReader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() fetches and caches global config', async () => {
    const stores = makeStores();
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    await reader.start();

    expect(reader.getGlobalConfig()).toEqual({
      concurrencyLimit: 3,
      dailyBudgetLimit: 100,
      defaultModel: 'claude-sonnet-4-6',
    });
    reader.stop();
  });

  it('start() fetches and caches repo config with active plugins', async () => {
    const stores = makeStores();
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    await reader.start();

    expect(reader.getRepoConfig('org', 'repo')).toEqual({
      id: 'repo-1',
      owner: 'org',
      name: 'repo',
      budgetLimit: 10,
      concurrencyLimit: 2,
      activePlugins: [
        { id: 'plugin-a', activatedAt: '2026-05-20T10:00:00.000Z' },
      ],
    });
    reader.stop();
  });

  it('uses defaults when global settings are not present', async () => {
    const stores = makeStores({
      settings: vi.fn().mockResolvedValue({
        ok: false,
        error: 'not-found',
        message: 'none',
      }),
    });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    await reader.start();

    expect(reader.getGlobalConfig()).toEqual({
      concurrencyLimit: 1,
      dailyBudgetLimit: null,
      defaultModel: 'claude-sonnet-4-6',
    });
    reader.stop();
  });

  it('poll failure keeps cached values and does not throw', async () => {
    const repos = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            id: 'repo-1',
            owner: 'org',
            name: 'repo',
            budgetLimit: 10,
            concurrencyLimit: 2,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db down',
      });
    const stores = makeStores({ repos });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await reader.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reader.getRepoConfig('org', 'repo')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[config-reader] Poll failed'),
      expect.any(String),
    );
    warn.mockRestore();
    reader.stop();
  });
});
