import { describe, expect, it } from 'vitest';
import type { ConciergeEventRecord, ConciergeEventStore } from '../memory/state-stores.js';
import { createGitRepoActivityClient, createRepoActivityPoller, type RepoBranchHead } from './repo-activity.js';

describe('repo activity poller', () => {
  it('emits metadata-only events for new branches and completed commits in watched repos', async () => {
    let now = 1_000;
    const events = inMemoryEvents(() => now);
    const snapshots = new Map<string, RepoBranchHead[]>();
    const poller = createRepoActivityPoller({
      events,
      watchedRepos: ['/repo', '/repo/secrets'],
      client: {
        listBranches: async (repoPath) => snapshots.get(repoPath) ?? [],
      },
    });

    snapshots.set('/repo', [{ name: 'dev', commit: 'aaa111' }]);
    snapshots.set('/repo/secrets', [{ name: 'main', commit: 'secret111' }]);
    await expect(poller.pollOnce()).resolves.toBe(false);
    expect(events.list()).toEqual([]);

    now = 2_000;
    snapshots.set('/repo', [
      { name: 'dev', commit: 'aaa111' },
      { name: 'feature/504', commit: 'bbb222' },
    ]);
    await expect(poller.pollOnce()).resolves.toBe(true);

    now = 3_000;
    snapshots.set('/repo', [
      { name: 'dev', commit: 'ccc333' },
      { name: 'feature/504', commit: 'bbb222' },
    ]);
    await expect(poller.pollOnce()).resolves.toBe(true);
    await expect(poller.pollOnce()).resolves.toBe(false);

    expect(events.list()).toEqual([
      {
        id: 1,
        source: 'observer',
        type: 'manual_branch_created',
        status: 'new',
        createdAt: 2_000,
        payload: {
          repoPath: '/repo',
          branch: 'feature/504',
          commit: 'bbb222',
        },
      },
      {
        id: 2,
        source: 'observer',
        type: 'manual_commit',
        status: 'new',
        createdAt: 3_000,
        payload: {
          repoPath: '/repo',
          branch: 'dev',
          commit: 'ccc333',
          previousCommit: 'aaa111',
        },
      },
    ]);
    for (const event of events.list()) {
      expect(event.payload).not.toHaveProperty('message');
      expect(event.payload).not.toHaveProperty('files');
      expect(event.payload).not.toHaveProperty('content');
    }
  });

  it('reads branch heads through git without commit messages or file content', async () => {
    const client = createGitRepoActivityClient({
      execFile: async (file, args) => {
        expect(file).toBe('git');
        expect(args).toEqual([
          '-C',
          '/repo',
          'for-each-ref',
          '--format=%(refname:short)%00%(objectname)',
          'refs/heads',
        ]);
        return { stdout: 'dev\u0000aaa111\nfeature/504\u0000bbb222\n' };
      },
    });

    await expect(client.listBranches('/repo')).resolves.toEqual([
      { name: 'dev', commit: 'aaa111' },
      { name: 'feature/504', commit: 'bbb222' },
    ]);
  });
});

function inMemoryEvents(now: () => number): ConciergeEventStore {
  const records: ConciergeEventRecord[] = [];
  return {
    append(input) {
      const record = {
        id: records.length + 1,
        createdAt: now(),
        ...input,
      };
      records.push(record);
      return record;
    },
    list() {
      return [...records];
    },
  };
}
