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
});
