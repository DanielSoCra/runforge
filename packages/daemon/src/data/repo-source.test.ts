import { describe, expect, it, vi } from 'vitest';

import {
  PostgresRepoDataSource,
  SupabaseRepoDataSource,
} from './repo-source.js';

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
});

describe('SupabaseRepoDataSource', () => {
  it('preserves the legacy upsert null-data error', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    };
    const source = new SupabaseRepoDataSource(supabase as never);

    const result = await source.upsertRepo('org', 'repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('upsertRepo returned null data');
    }
  });

  it('reads connection tokens through the app-owned credential store', async () => {
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const supabase = {
      from: vi.fn().mockReturnValue({ update }),
    };
    const credentials = {
      readConnectionCredential: vi.fn().mockResolvedValue({
        ok: true,
        value: 'connection-token',
      }),
    };
    const source = new SupabaseRepoDataSource(
      supabase as never,
      credentials as never,
    );

    await expect(
      source.resolveConnectionToken('repo-1', 'conn-1'),
    ).resolves.toBe('connection-token');
    expect(credentials.readConnectionCredential).toHaveBeenCalledWith('conn-1');
    expect(update).toHaveBeenCalledWith({
      credential_status: 'ok',
      credential_error: null,
      updated_at: expect.any(String),
    });
  });

  it('marks credential errors when no app-owned credential store is configured', async () => {
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const supabase = {
      from: vi.fn().mockReturnValue({ update }),
    };
    const source = new SupabaseRepoDataSource(supabase as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      source.resolveConnectionToken('repo-1', 'conn-1'),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith({
      credential_status: 'error',
      credential_error: 'app-owned credential store is not configured',
      updated_at: expect.any(String),
    });

    warn.mockRestore();
  });
});
