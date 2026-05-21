import { describe, it, expect, vi } from 'vitest';

import { RepoManager } from './repo-manager.js';
import type { DataRepoRecord, RepoDataSource } from '../data/repo-source.js';
import { ok, err, type Result } from '../lib/result.js';

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    issues = {};
  },
}));

vi.mock('./phase-labels.js', () => ({
  createPhaseLabelMirror: () => ({
    provisionLabels: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('./work-detection.js', () => ({
  createWorkDetector: vi.fn((_octokit, owner: string, repo: string) => ({
    owner,
    repo,
  })),
}));

class FakeRepoSource implements RepoDataSource {
  repos: DataRepoRecord[];
  upsertResult: Result<string>;
  tokenResult: string | undefined = 'token';
  resolveCalls: Array<{ repoId: string; connectionId: string }> = [];

  constructor(repos: DataRepoRecord[] = []) {
    this.repos = repos;
    this.upsertResult = ok('new-id');
  }

  async listEnabledRepos(): Promise<Result<DataRepoRecord[]>> {
    return ok(this.repos);
  }

  async upsertRepo(_owner: string, _name: string): Promise<Result<string>> {
    return this.upsertResult;
  }

  async resolveConnectionToken(
    repoId: string,
    connectionId: string,
  ): Promise<string | undefined> {
    this.resolveCalls.push({ repoId, connectionId });
    return this.tokenResult;
  }
}

const repo = (
  id: string,
  owner = 'acme',
  name = id,
  connectionId: string | null = null,
): DataRepoRecord => ({
  id,
  owner,
  name,
  poll_interval_ms: null,
  connection_id: connectionId,
});

describe('RepoManager', () => {
  it('starts pollers for all enabled repos on initialize', async () => {
    const source = new FakeRepoSource([repo('web'), repo('api')]);
    const mgr = new RepoManager(source, 60_000, vi.fn());

    await mgr.initialize();

    expect(mgr.activePollerCount()).toBe(2);
    mgr.stop();
  });

  it('reload adds new enabled repos and removes disabled ones', async () => {
    const source = new FakeRepoSource([repo('r1'), repo('r2')]);
    const mgr = new RepoManager(source, 60_000, vi.fn());
    await mgr.initialize();
    expect(mgr.activePollerCount()).toBe(2);

    source.repos = [repo('r1')];
    await mgr.reload();

    expect(mgr.activePollerCount()).toBe(1);
    mgr.stop();
  });

  it('graceful disable removes idle pollers immediately', async () => {
    const mgr = new RepoManager(
      new FakeRepoSource([repo('r1')]),
      60_000,
      vi.fn(),
    );
    await mgr.initialize();

    mgr.disablePoller('r1');

    expect(mgr.activePollerCount()).toBe(0);
    mgr.stop();
  });

  it('graceful disable defers removal while a run is active', async () => {
    const mgr = new RepoManager(
      new FakeRepoSource([repo('r1')]),
      60_000,
      vi.fn(),
    );
    await mgr.initialize();

    mgr.notifyRunStart('r1');
    mgr.disablePoller('r1');
    expect(mgr.activePollerCount()).toBe(1);

    mgr.notifyRunEnd('r1');
    expect(mgr.activePollerCount()).toBe(0);
    mgr.stop();
  });

  it('scanNow immediately calls onPoll for all active pollers and returns count', async () => {
    const onPoll = vi.fn();
    const mgr = new RepoManager(
      new FakeRepoSource([repo('r1'), repo('r2')]),
      60_000,
      onPoll,
    );
    await mgr.initialize();

    const result = await mgr.scanNow();

    expect(result.scanned).toBe(2);
    expect(onPoll).toHaveBeenCalledTimes(2);
    mgr.stop();
  });

  it('scanNow skips pollers marked pendingDisable with active runs', async () => {
    const onPoll = vi.fn();
    const mgr = new RepoManager(
      new FakeRepoSource([repo('r1'), repo('r2')]),
      60_000,
      onPoll,
    );
    await mgr.initialize();

    mgr.notifyRunStart('r1');
    mgr.disablePoller('r1');
    const result = await mgr.scanNow();

    expect(result.scanned).toBe(1);
    expect(onPoll).not.toHaveBeenCalledWith(
      'r1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(onPoll).toHaveBeenCalledWith('r2', 'acme', 'r2', expect.any(Object));
    mgr.stop();
  });

  it('does not start an overlapping interval poll while the previous poll is still running', async () => {
    vi.useFakeTimers();
    let resolvePoll!: () => void;
    const pendingPoll = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });
    const onPoll = vi.fn(() => pendingPoll);
    const source = new FakeRepoSource([
      { ...repo('r1'), poll_interval_ms: 1000 },
    ]);
    const mgr = new RepoManager(source, 60_000, onPoll);

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

  it('upsertRepo returns source errors', async () => {
    const source = new FakeRepoSource();
    source.upsertResult = err(new Error('upsert failed'));
    const mgr = new RepoManager(source, 60_000, vi.fn());

    const result = await mgr.upsertRepo('acme', 'web');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('upsert failed');
    mgr.stop();
  });

  it('resolveTokenForRepo returns per-connection token for DB repos', async () => {
    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'global-fallback';
    const source = new FakeRepoSource([
      repo('r1', 'acme', 'web', 'conn-abc'),
      repo('r2', 'acme', 'api', null),
    ]);
    source.tokenResult = 'decrypted-oauth-token';
    const mgr = new RepoManager(source, 60_000, vi.fn());

    try {
      await mgr.initialize();
      source.resolveCalls = [];

      await expect(mgr.resolveTokenForRepo('r1')).resolves.toBe(
        'decrypted-oauth-token',
      );
      expect(source.resolveCalls).toEqual([
        { repoId: 'r1', connectionId: 'conn-abc' },
      ]);

      await expect(mgr.resolveTokenForRepo('r2')).resolves.toBe(
        'global-fallback',
      );
      await expect(mgr.resolveTokenForRepo('missing')).resolves.toBe(
        'global-fallback',
      );
      mgr.stop();
    } finally {
      process.env.GITHUB_TOKEN = originalEnv;
    }
  });

  it('skips pollers when per-connection token resolution fails', async () => {
    const source = new FakeRepoSource([repo('r1', 'acme', 'web', 'conn-1')]);
    source.tokenResult = undefined;
    const mgr = new RepoManager(source, 60_000, vi.fn());

    await mgr.initialize();

    expect(mgr.activePollerCount()).toBe(0);
    expect(source.resolveCalls).toEqual([
      { repoId: 'r1', connectionId: 'conn-1' },
    ]);
    mgr.stop();
  });
});
