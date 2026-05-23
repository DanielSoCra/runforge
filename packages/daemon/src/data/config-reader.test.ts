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

  it('tryFetch() loads and caches global config and clears degraded', async () => {
    const stores = makeStores();
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    expect(reader.isStartupDegraded()).toBe(true);

    const result = await reader.tryFetch();

    expect(result.ok).toBe(true);
    expect(reader.isStartupDegraded()).toBe(false);
    expect(reader.getLastConfigError()).toBeNull();
    expect(reader.getGlobalConfig()).toEqual({
      concurrencyLimit: 3,
      dailyBudgetLimit: 100,
      defaultModel: 'claude-sonnet-4-6',
    });
  });

  it('tryFetch() loads and caches repo config with active plugins', async () => {
    const stores = makeStores();
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    await reader.tryFetch();

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
  });

  it('tryFetch() uses defaults when global settings are not present', async () => {
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

    const result = await reader.tryFetch();

    expect(result.ok).toBe(true);
    expect(reader.getGlobalConfig()).toEqual({
      concurrencyLimit: 1,
      dailyBudgetLimit: null,
      defaultModel: 'claude-sonnet-4-6',
    });
  });

  it('tryFetch() maps unavailable/unreachable with structured cause', async () => {
    const stores = makeStores({
      settings: vi.fn().mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'select global_settings — ECONNREFUSED: connect refused',
        category: 'unreachable',
        cause: {
          class: 'Error',
          code: 'ECONNREFUSED',
          message: 'connect refused',
        },
      }),
    });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    const result = await reader.tryFetch();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.category).toBe('unreachable');
    expect(result.error.cause.code).toBe('ECONNREFUSED');
    expect(reader.isStartupDegraded()).toBe(true);
    expect(reader.getLastConfigError()?.category).toBe('unreachable');
  });

  it('tryFetch() maps unavailable/rejected with structured cause', async () => {
    const stores = makeStores({
      settings: vi.fn().mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'auth failed',
        category: 'rejected',
        cause: { class: 'Error', code: '28P01', message: 'auth failed' },
      }),
    });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    const result = await reader.tryFetch();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.category).toBe('rejected');
    expect(result.error.cause.code).toBe('28P01');
  });

  it('tryFetch() maps denied to rejected', async () => {
    const stores = makeStores({
      repos: vi.fn().mockResolvedValue({
        ok: false,
        error: 'denied',
        message: 'permission denied for table repos',
      }),
    });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    const result = await reader.tryFetch();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.category).toBe('rejected');
    expect(result.error.cause.class).toBe('StoreDenied');
  });

  it('start() does not fetch; only the timer fires a fetch', async () => {
    const stores = makeStores();
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    await reader.start();

    // start() must not have triggered any store read.
    expect(stores.settings.readGlobalSettings).not.toHaveBeenCalled();
    expect(stores.repos.listEnabledRepositories).not.toHaveBeenCalled();

    // The timer fires the fetch later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stores.settings.readGlobalSettings).toHaveBeenCalled();
    reader.stop();
  });

  it('startupDegraded never flips back to true after a successful load', async () => {
    const settings = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          concurrencyLimit: 3,
          dailyBudgetLimit: 100,
          defaultModel: 'claude-sonnet-4-6',
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db down',
        category: 'unreachable',
        cause: { class: 'Error', code: 'ECONNREFUSED', message: 'down' },
      });
    const stores = makeStores({ settings });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );

    await reader.tryFetch();
    expect(reader.isStartupDegraded()).toBe(false);

    await reader.tryFetch();
    expect(reader.isStartupDegraded()).toBe(false);
  });

  it('poll failure keeps cached values and does not throw', async () => {
    const repos = vi
      .fn()
      // First call: initial bootstrap via tryFetch (success, caches config).
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
      // Second call: the timer-driven poll fails.
      .mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db down',
        category: 'unreachable',
        cause: { class: 'Error', code: 'ECONNREFUSED', message: 'db down' },
      });
    const stores = makeStores({ repos });
    const reader = new PostgresConfigReader(
      stores.settings as never,
      stores.repos as never,
      stores.plugins as never,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Bootstrap is now the daemon's responsibility (tryFetch); emulate it here.
    await reader.tryFetch();
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
