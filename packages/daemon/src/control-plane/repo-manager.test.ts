import { describe, it, expect, vi } from 'vitest';
import { RepoManager } from './repo-manager.js';

describe('RepoManager', () => {
  it('starts pollers for all enabled repos on initialize', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [
            { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
            { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
          ],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(2);
    mgr.stop();
  });

  it('reload adds new enabled repos and removes disabled ones', async () => {
    const onPoll = vi.fn();
    let callCount = 0;
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockImplementation(() => {
          callCount++;
          // First call: 2 repos. Second call (after reload): 1 repo.
          const repos = callCount === 1
            ? [
                { id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null },
                { id: 'r2', owner: 'c', name: 'd', poll_interval_ms: null, connection_id: null },
              ]
            : [
                { id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null },
              ];
          return Promise.resolve({ data: repos, error: null });
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(2);

    await mgr.reload();
    expect(mgr.activePollerCount()).toBe(1);
    mgr.stop();
  });

  it('graceful disable: poller removed immediately when activeRuns=0', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [{ id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null }],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(1);

    // Disable with no active runs — should remove immediately
    mgr.disablePoller('r1');
    expect(mgr.activePollerCount()).toBe(0);
    mgr.stop();
  });

  it('graceful disable: poller deferred when activeRuns>0', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [{ id: 'r1', owner: 'a', name: 'b', poll_interval_ms: null, connection_id: null }],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();

    mgr.notifyRunStart('r1'); // activeRuns = 1
    mgr.disablePoller('r1'); // should not remove yet
    expect(mgr.activePollerCount()).toBe(1); // still there

    mgr.notifyRunEnd('r1'); // activeRuns back to 0 → remove
    expect(mgr.activePollerCount()).toBe(0);
    mgr.stop();
  });

  it('scanNow() immediately calls onPoll for all active pollers and returns count', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [
            { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
            { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
          ],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();

    const result = await mgr.scanNow();
    expect(result.scanned).toBe(2);
    expect(onPoll).toHaveBeenCalledTimes(2);
    mgr.stop();
  });

  it('scanNow() skips pollers that are pendingDisable', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [
            { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
            { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
          ],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    mgr.disablePoller('r1'); // marks pendingDisable (no active runs, so removes immediately)

    const result = await mgr.scanNow();
    expect(result.scanned).toBe(1);
    mgr.stop();
  });

  it('scanNow() skips pollers marked pendingDisable with active runs', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [
            { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: null },
            { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
          ],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();

    // Mark r1 as having an active run so disablePoller defers removal
    mgr.notifyRunStart('r1');
    mgr.disablePoller('r1'); // pendingDisable=true, stays in map

    const result = await mgr.scanNow();
    expect(result.scanned).toBe(1); // only r2
    expect(onPoll).not.toHaveBeenCalledWith('r1', expect.anything(), expect.anything(), expect.anything());
    expect(onPoll).toHaveBeenCalledWith('r2', 'acme', 'api', expect.any(Object));
    mgr.stop();
  });

  it('does not start an overlapping interval poll while the previous poll is still running', async () => {
    vi.useFakeTimers();
    let resolvePoll!: () => void;
    const pendingPoll = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });
    const onPoll = vi.fn(() => pendingPoll);
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({
          data: [{ id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: 1000, connection_id: null }],
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as unknown as ConstructorParameters<typeof RepoManager>[0];

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    try {
      await mgr.initialize();

      await vi.advanceTimersByTimeAsync(1000);
      expect(onPoll).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(onPoll).toHaveBeenCalledTimes(1);

      resolvePoll();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(onPoll).toHaveBeenCalledTimes(2);
    } finally {
      mgr.stop();
      vi.useRealTimers();
    }
  });

  it('upsertRepo returns err() when Supabase returns null data without error', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'repos') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockResolvedValue({ data: [], error: null }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    const result = await mgr.upsertRepo('acme', 'web');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('upsertRepo returned null data');
    mgr.stop();
  });

  it('resolveToken logs warning and falls back to GITHUB_TOKEN when RPC fails', async () => {
    const onPoll = vi.fn();
    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fallback-token';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const supabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({
            data: [{ id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: 'conn-1' }],
            error: null,
          }),
        }),
        rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC failed: missing row' } }),
      } as any;

      const mgr = new RepoManager(supabase, 60_000, onPoll);
      await mgr.initialize();

      // The poller should still be created (using fallback token)
      expect(mgr.activePollerCount()).toBe(1);
      // A warning should have been logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('decrypt_github_token RPC failed for connection conn-1'),
      );

      mgr.stop();
    } finally {
      warnSpy.mockRestore();
      process.env.GITHUB_TOKEN = originalEnv;
    }
  });

  it('resolveToken logs warning when RPC returns null data without error', async () => {
    const onPoll = vi.fn();
    const originalEnv = process.env.GITHUB_TOKEN;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const supabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({
            data: [{ id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: 'conn-2' }],
            error: null,
          }),
        }),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any;

      const mgr = new RepoManager(supabase, 60_000, onPoll);
      await mgr.initialize();

      expect(mgr.activePollerCount()).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('decrypt_github_token returned null for connection conn-2'),
      );

      mgr.stop();
    } finally {
      warnSpy.mockRestore();
      process.env.GITHUB_TOKEN = originalEnv;
    }
  });

  it('resolveTokenForRepo returns per-connection token for DB repos (#359)', async () => {
    const onPoll = vi.fn();
    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'global-fallback';

    try {
      const supabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({
            data: [
              { id: 'r1', owner: 'acme', name: 'web', poll_interval_ms: null, connection_id: 'conn-abc' },
              { id: 'r2', owner: 'acme', name: 'api', poll_interval_ms: null, connection_id: null },
            ],
            error: null,
          }),
        }),
        rpc: vi.fn().mockResolvedValue({ data: 'decrypted-oauth-token', error: null }),
      } as any;

      const mgr = new RepoManager(supabase, 60_000, onPoll);
      await mgr.initialize();

      // Repo with connection_id should resolve per-connection token
      const token1 = await mgr.resolveTokenForRepo('r1');
      expect(token1).toBe('decrypted-oauth-token');
      expect(supabase.rpc).toHaveBeenCalledWith('decrypt_github_token', { p_connection_id: 'conn-abc' });

      // Repo without connection_id should fall back to GITHUB_TOKEN
      supabase.rpc.mockClear();
      const token2 = await mgr.resolveTokenForRepo('r2');
      expect(token2).toBe('global-fallback');

      // Unknown repo should fall back to GITHUB_TOKEN
      const token3 = await mgr.resolveTokenForRepo('nonexistent');
      expect(token3).toBe('global-fallback');

      mgr.stop();
    } finally {
      process.env.GITHUB_TOKEN = originalEnv;
    }
  });

  it('upsertRepo inserts a repo and returns its id', async () => {
    const onPoll = vi.fn();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'repos') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockResolvedValue({ data: [], error: null }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'new-id' }, error: null }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: 'token', error: null }),
    } as any;

    const mgr = new RepoManager(supabase, 60_000, onPoll);
    await mgr.initialize();
    const result = await mgr.upsertRepo('acme', 'web');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('new-id');
    mgr.stop();
  });
});
