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
