import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseConfigReader } from './config-reader.js';

const makeClient = () => {
  const repoPluginsData = [{ repo_id: 'repo1', plugin_id: 'p1', activated_at: '2025-01-01T00:00:00Z' }];
  const reposData = [{ id: 'repo1', owner: 'org', name: 'repo', budget_limit: 10, concurrency_limit: 1 }];
  const globalData = [{ id: 'gs1', concurrency_limit: 3, daily_budget_limit: 100, default_model: 'claude-sonnet-4-6' }];

  let callCount = 0;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'global_settings') {
        return {
          select: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: globalData, error: null }),
          }),
        };
      }
      if (table === 'repos') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockResolvedValue({ data: reposData, error: null }),
            }),
          }),
        };
      }
      if (table === 'repo_plugins') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: repoPluginsData, error: null }),
          }),
        };
      }
      return { select: vi.fn() };
    }),
  };
};

describe('SupabaseConfigReader', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() fetches and caches global config', async () => {
    const client = makeClient();
    const reader = new SupabaseConfigReader(client as any);
    await reader.start();
    const global = reader.getGlobalConfig();
    expect(global.concurrencyLimit).toBe(3);
    expect(global.dailyBudgetLimit).toBe(100);
    expect(global.defaultModel).toBe('claude-sonnet-4-6');
    reader.stop();
  });

  it('start() fetches and caches repo config with plugins', async () => {
    const client = makeClient();
    const reader = new SupabaseConfigReader(client as any);
    await reader.start();
    const repo = reader.getRepoConfig('org', 'repo');
    expect(repo).toBeDefined();
    expect(repo!.id).toBe('repo1');
    expect(repo!.budgetLimit).toBe(10);
    expect(repo!.activePlugins).toEqual([{ id: 'p1', activatedAt: '2025-01-01T00:00:00Z' }]);
    reader.stop();
  });

  it('getRepoConfig returns undefined for unknown repo', async () => {
    const client = makeClient();
    const reader = new SupabaseConfigReader(client as any);
    await reader.start();
    expect(reader.getRepoConfig('unknown', 'repo')).toBeUndefined();
    reader.stop();
  });

  it('uses DAEMON_SYNC_INTERVAL_MS env var for poll interval', async () => {
    const original = process.env.DAEMON_SYNC_INTERVAL_MS;
    process.env.DAEMON_SYNC_INTERVAL_MS = '5000';
    try {
      const client = makeClient();
      const reader = new SupabaseConfigReader(client as any);
      await reader.start();
      const callsBefore = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      const callsAfter = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
      reader.stop();
    } finally {
      if (original === undefined) delete process.env.DAEMON_SYNC_INTERVAL_MS;
      else process.env.DAEMON_SYNC_INTERVAL_MS = original;
    }
  });

  it('falls back to 60s default for invalid DAEMON_SYNC_INTERVAL_MS', async () => {
    const original = process.env.DAEMON_SYNC_INTERVAL_MS;
    process.env.DAEMON_SYNC_INTERVAL_MS = 'notanumber';
    try {
      const client = makeClient();
      const reader = new SupabaseConfigReader(client as any);
      await reader.start();
      const callsBefore = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
      // Should NOT poll at 5s since value is invalid — falls back to 60s
      await vi.advanceTimersByTimeAsync(5_000);
      expect((client.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
      // Should poll at 60s
      await vi.advanceTimersByTimeAsync(55_000);
      expect((client.from as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
      reader.stop();
    } finally {
      if (original === undefined) delete process.env.DAEMON_SYNC_INTERVAL_MS;
      else process.env.DAEMON_SYNC_INTERVAL_MS = original;
    }
  });

  it('polls again after 60s', async () => {
    const client = makeClient();
    const reader = new SupabaseConfigReader(client as any);
    await reader.start();
    const callsBefore = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const callsAfter = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
    reader.stop();
  });

  it('stop() prevents further polling', async () => {
    const client = makeClient();
    const reader = new SupabaseConfigReader(client as any);
    await reader.start();
    reader.stop();
    const callsAfterStop = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    const callsAfterTimer = (client.from as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterTimer).toBe(callsAfterStop);
  });

  it('start() throws if initial fetch fails', async () => {
    const client = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused' } }),
        }),
      }),
    };
    const reader = new SupabaseConfigReader(client as any);
    await expect(reader.start()).rejects.toThrow('[config-reader] global_settings fetch failed');
  });

  it('poll failure keeps cached values and does not throw', async () => {
    const client = makeClient();
    const reader = new SupabaseConfigReader(client as any);
    await reader.start();

    // Simulate a poll failure by making the next fetch fail
    (client.from as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }),
      }),
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    // Cache should still have the original values
    const global = reader.getGlobalConfig();
    expect(global.concurrencyLimit).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[config-reader] Poll failed'), expect.any(String));
    warn.mockRestore();
    reader.stop();
  });
});
