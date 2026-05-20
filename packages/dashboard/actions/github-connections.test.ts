import { revalidatePath } from 'next/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireDashboardAdmin } from '@/lib/auth/require-session';

import { importRepos, removeConnection, removeRepo } from './github-connections';

const mocks = vi.hoisted(() => ({
  importRepositories: vi.fn(),
  removeConnection: vi.fn(),
  removeRepository: vi.fn(),
  requireDashboardAdmin: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    githubConnections: {
      importRepositories: mocks.importRepositories,
      removeConnection: mocks.removeConnection,
      removeRepository: mocks.removeRepository,
    },
  }),
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DAEMON_URL;
  globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));
  mocks.requireDashboardAdmin.mockResolvedValue({
    user: { id: 'admin-1', role: 'admin' },
  });
  mocks.importRepositories.mockResolvedValue({ ok: true, value: undefined });
  mocks.removeConnection.mockResolvedValue({
    ok: true,
    value: { disableError: undefined },
  });
  mocks.removeRepository.mockResolvedValue({ ok: true, value: undefined });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.DAEMON_URL;
});

describe('removeConnection', () => {
  it('requires an admin before mutating connection data', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );

    await expect(removeConnection('conn-1')).rejects.toThrow(
      'Admin access required',
    );

    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it('removes through the app-owned store and reloads dashboard state', async () => {
    process.env.DAEMON_URL = 'http://localhost:7532/';

    await removeConnection('conn-1');

    expect(requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.removeConnection).toHaveBeenCalledWith('conn-1');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:7532/repos/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Requested-By': 'dashboard' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
  });

  it('silently swallows fetch failure when daemon is unreachable (#179)', async () => {
    process.env.DAEMON_URL = 'http://localhost:9999';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(removeConnection('conn-1')).resolves.not.toThrow();

    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('keeps removal successful when linked repo disabling reports a warning (#277)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.removeConnection.mockResolvedValueOnce({
      ok: true,
      value: { disableError: 'disable failed' },
    });

    await expect(removeConnection('conn-1')).resolves.not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[github-connections] removeConnection disable repos failed:',
      'disable failed',
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
    consoleSpy.mockRestore();
  });

  it('does not revalidate or notify when store removal fails (#277)', async () => {
    mocks.removeConnection.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db unavailable',
    });
    process.env.DAEMON_URL = 'http://localhost:7532/';

    await expect(removeConnection('conn-1')).rejects.toThrow(
      'Failed to remove connection',
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('importRepos', () => {
  it('requires an admin before importing repositories', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );

    await expect(
      importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]),
    ).rejects.toThrow('Admin access required');

    expect(mocks.importRepositories).not.toHaveBeenCalled();
  });

  it('returns early for an empty import list', async () => {
    await importRepos('conn-1', []);

    expect(mocks.importRepositories).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('rejects owner containing shell metacharacters', async () => {
    await expect(
      importRepos('conn-1', [{ owner: 'foo;rm -rf', name: 'bar' }]),
    ).rejects.toThrow('Owner must contain only alphanumeric characters');
    expect(mocks.importRepositories).not.toHaveBeenCalled();
  });

  it('rejects name containing shell metacharacters', async () => {
    await expect(
      importRepos('conn-1', [{ owner: 'foo', name: 'bar$(evil)' }]),
    ).rejects.toThrow('Name must contain only alphanumeric characters');
    expect(mocks.importRepositories).not.toHaveBeenCalled();
  });

  it('rejects owner with spaces', async () => {
    await expect(
      importRepos('conn-1', [{ owner: 'foo bar', name: 'repo' }]),
    ).rejects.toThrow('Owner must contain only alphanumeric characters');
    expect(mocks.importRepositories).not.toHaveBeenCalled();
  });

  it('imports valid repos through the app-owned store and notifies the daemon', async () => {
    process.env.DAEMON_URL = 'http://localhost:7532/';
    const repositories = [{ owner: 'my-org.test', name: 'repo_name-1' }];

    await importRepos('conn-1', repositories);

    expect(mocks.importRepositories).toHaveBeenCalledWith(
      'conn-1',
      repositories,
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:7532/repos/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Requested-By': 'dashboard' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
  });

  it('throws when the store import fails (#176)', async () => {
    mocks.importRepositories.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'update failed',
    });

    await expect(
      importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]),
    ).rejects.toThrow('Failed to import repository');
  });

  it('silently swallows fetch failure when daemon is unreachable (#166)', async () => {
    process.env.DAEMON_URL = 'http://localhost:9999';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]),
    ).resolves.not.toThrow();

    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe('removeRepo', () => {
  it('soft-deletes the repo through the app-owned store', async () => {
    await removeRepo('repo-1', 'conn-1');

    expect(mocks.removeRepository).toHaveBeenCalledWith('repo-1', 'conn-1');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
  });

  it('throws a generic error if the update fails', async () => {
    mocks.removeRepository.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db error',
    });

    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow(
      'Failed to remove repository',
    );
  });

  it('rejects removal of an enabled repo (#172)', async () => {
    mocks.removeRepository.mockResolvedValueOnce({
      ok: false,
      error: 'conflict',
      message: 'enabled repositories must be disabled before removal',
    });

    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow(
      'Cannot remove an enabled repository',
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('throws when repo is not found (#172)', async () => {
    mocks.removeRepository.mockResolvedValueOnce({
      ok: false,
      error: 'not-found',
      message: 'repository was not found',
    });

    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow(
      'Repository not found',
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
