import { describe, expect, it, vi } from 'vitest';

import { PostgresRepoDataSource } from './repo-source.js';

describe('PostgresRepoDataSource', () => {
  it('maps enabled repositories from Store shape to daemon repo records', async () => {
    const source = new PostgresRepoDataSource(
      {
        listEnabledRepositories: vi.fn().mockResolvedValue({
          ok: true,
          value: [
            {
              id: 'repo-1',
              owner: 'org',
              name: 'repo',
              pollIntervalMs: 30_000,
              connectionId: 'conn-1',
            },
          ],
        }),
      } as never,
      {} as never,
    );

    await expect(source.listEnabledRepos()).resolves.toEqual({
      ok: true,
      value: [
        {
          id: 'repo-1',
          owner: 'org',
          name: 'repo',
          poll_interval_ms: 30_000,
          connection_id: 'conn-1',
        },
      ],
    });
  });

  it('upserts repositories through the Postgres store', async () => {
    const repos = {
      upsertRepository: vi.fn().mockResolvedValue({
        ok: true,
        value: { id: 'repo-1' },
      }),
    };
    const source = new PostgresRepoDataSource(repos as never, {} as never);

    await expect(source.upsertRepo('org', 'repo')).resolves.toEqual({
      ok: true,
      value: 'repo-1',
    });
    expect(repos.upsertRepository).toHaveBeenCalledWith({
      owner: 'org',
      name: 'repo',
      enabled: true,
    });
  });

  it('updates credential status when a connection token is read', async () => {
    const repos = {
      setCredentialStatus: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const credentials = {
      readConnectionCredential: vi.fn().mockResolvedValue({
        ok: true,
        value: 'token',
      }),
    };
    const source = new PostgresRepoDataSource(
      repos as never,
      credentials as never,
    );

    await expect(
      source.resolveConnectionToken('repo-1', 'conn-1'),
    ).resolves.toBe('token');
    expect(repos.setCredentialStatus).toHaveBeenCalledWith(
      'repo-1',
      'ok',
      undefined,
    );
  });

  it('marks credential errors when token reading fails', async () => {
    const repos = {
      setCredentialStatus: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const credentials = {
      readConnectionCredential: vi.fn().mockResolvedValue({
        ok: false,
        error: 'denied',
        message: 'bad key',
      }),
    };
    const source = new PostgresRepoDataSource(
      repos as never,
      credentials as never,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      source.resolveConnectionToken('repo-1', 'conn-1'),
    ).resolves.toBeUndefined();
    expect(repos.setCredentialStatus).toHaveBeenCalledWith(
      'repo-1',
      'error',
      'bad key',
    );

    warn.mockRestore();
  });

  it('marks credential errors when token reading returns an empty token', async () => {
    const repos = {
      setCredentialStatus: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const credentials = {
      readConnectionCredential: vi.fn().mockResolvedValue({
        ok: true,
        value: ' ',
      }),
    };
    const source = new PostgresRepoDataSource(
      repos as never,
      credentials as never,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      source.resolveConnectionToken('repo-1', 'conn-1'),
    ).resolves.toBeUndefined();
    expect(repos.setCredentialStatus).toHaveBeenCalledWith(
      'repo-1',
      'error',
      'GitHub connection credential returned empty',
    );

    warn.mockRestore();
  });
});
