import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Chain helper: eq().eq() for removeRepo, eq() for removeConnection/others
const makeEqChain = (result: { error: null | { message: string } }) => {
  const inner = vi.fn().mockResolvedValue(result);
  const outer = vi.fn().mockReturnValue({ eq: inner });
  return { outer, inner };
};

const mockRepos = {
  update: vi.fn(),
};
const mockConnections = {
  delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
};
const mockFrom = vi.fn((table: string) => table === 'repos' ? mockRepos : mockConnections);

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
    from: mockFrom,
  }),
}));
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn().mockResolvedValue(undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('removeConnection', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRepos.update.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    mockConnections.delete.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  });

  it('sets repos enabled=false and connection_id=null before deleting', async () => {
    const { removeConnection } = await import('./github-connections.js');
    await removeConnection('conn-1');
    expect(mockRepos.update).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, connection_id: null })
    );
  });

  it('fires POST to DAEMON_URL/repos/reload after removal (#179)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));
    process.env.DAEMON_URL = 'http://localhost:7532';
    try {
      const { removeConnection } = await import('./github-connections.js');
      await removeConnection('conn-1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:7532/repos/reload',
        expect.objectContaining({
          method: 'POST',
          headers: { 'X-Requested-By': 'dashboard' },
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.DAEMON_URL;
    }
  });

  it('silently swallows fetch failure when daemon is unreachable (#179)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    process.env.DAEMON_URL = 'http://localhost:9999';
    try {
      const { removeConnection } = await import('./github-connections.js');
      await expect(removeConnection('conn-1')).resolves.not.toThrow();
      expect(globalThis.fetch).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.DAEMON_URL;
    }
  });

  it('throws and does not delete connection when repos update fails (#173)', async () => {
    vi.resetModules();
    mockRepos.update.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: { message: 'RLS violation' } }),
    });
    const deleteSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    mockConnections.delete = deleteSpy;
    const { removeConnection } = await import('./github-connections.js');
    await expect(removeConnection('conn-1')).rejects.toThrow('Failed to disconnect repos');
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe('removeRepo', () => {
  function setupRemoveRepoMock(opts: { enabled: boolean; fetchError?: boolean; updateError?: boolean }) {
    // select('enabled').eq('id',...).eq('connection_id',...).single()
    const singleFn = vi.fn().mockResolvedValue(
      opts.fetchError
        ? { data: null, error: { message: 'not found' } }
        : { data: { enabled: opts.enabled }, error: null },
    );
    const selectEqInner = vi.fn().mockReturnValue({ single: singleFn });
    const selectEqOuter = vi.fn().mockReturnValue({ eq: selectEqInner });
    (mockRepos as Record<string, unknown>).select = vi.fn().mockReturnValue({ eq: selectEqOuter });

    // update().eq().eq()
    const { outer } = makeEqChain({ error: opts.updateError ? { message: 'db error' } : null });
    mockRepos.update.mockReturnValue({ eq: outer });
  }

  beforeEach(() => {
    vi.resetModules();
    setupRemoveRepoMock({ enabled: false });
  });

  it('soft-deletes the repo by setting deleted_at and enabled=false', async () => {
    const { removeRepo } = await import('./github-connections.js');
    await removeRepo('repo-1', 'conn-1');
    expect(mockRepos.update).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, deleted_at: expect.any(String) })
    );
  });

  it('throws a generic error if the update fails', async () => {
    vi.resetModules();
    setupRemoveRepoMock({ enabled: false, updateError: true });
    const { removeRepo } = await import('./github-connections.js');
    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow('Failed to remove repository');
  });

  it('rejects removal of an enabled repo (#172)', async () => {
    vi.resetModules();
    setupRemoveRepoMock({ enabled: true });
    mockRepos.update.mockClear();
    const { removeRepo } = await import('./github-connections.js');
    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow(
      'Cannot remove an enabled repository'
    );
    expect(mockRepos.update).not.toHaveBeenCalled();
  });

  it('throws when repo is not found (#172)', async () => {
    vi.resetModules();
    setupRemoveRepoMock({ enabled: false, fetchError: true });
    mockRepos.update.mockClear();
    const { removeRepo } = await import('./github-connections.js');
    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow('Repository not found');
    expect(mockRepos.update).not.toHaveBeenCalled();
  });
});

describe('importRepos', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DAEMON_URL;
  });

  it('rejects owner containing shell metacharacters', async () => {
    const { importRepos } = await import('./github-connections.js');
    await expect(importRepos('conn-1', [{ owner: 'foo;rm -rf', name: 'bar' }]))
      .rejects.toThrow('Owner must contain only alphanumeric characters');
  });

  it('rejects name containing shell metacharacters', async () => {
    const { importRepos } = await import('./github-connections.js');
    await expect(importRepos('conn-1', [{ owner: 'foo', name: 'bar$(evil)' }]))
      .rejects.toThrow('Name must contain only alphanumeric characters');
  });

  it('rejects owner with spaces', async () => {
    const { importRepos } = await import('./github-connections.js');
    await expect(importRepos('conn-1', [{ owner: 'foo bar', name: 'repo' }]))
      .rejects.toThrow('Owner must contain only alphanumeric characters');
  });

  // Helper: mock that supports both upsert (step 1) and update().eq().eq() (step 2)
  function setupImportMock() {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockUpdatePayload = vi.fn();
    const eqName = vi.fn().mockResolvedValue({ error: null });
    const eqOwner = vi.fn().mockReturnValue({ eq: eqName });
    mockUpdatePayload.mockReturnValue({ eq: eqOwner });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFrom.mockImplementation((() => ({ upsert: mockUpsert, update: mockUpdatePayload })) as any);
    return { mockUpsert, mockUpdatePayload };
  }

  it('accepts valid owner and name with dots, underscores, hyphens', async () => {
    const { mockUpsert } = setupImportMock();
    const { importRepos } = await import('./github-connections.js');
    await importRepos('conn-1', [{ owner: 'my-org.test', name: 'repo_name-1' }]);
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('inserts new repos with enabled=false per credential-first workflow (SPEC-4 regression)', async () => {
    const { mockUpsert } = setupImportMock();
    const { importRepos } = await import('./github-connections.js');
    await importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ ignoreDuplicates: true }),
    );
  });

  it('update step does not include enabled field, preserving existing state (#176)', async () => {
    const { mockUpdatePayload } = setupImportMock();
    const { importRepos } = await import('./github-connections.js');
    await importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]);
    const updateArg = mockUpdatePayload.mock.calls[0][0];
    expect(updateArg).toEqual({ connection_id: 'conn-1', deleted_at: null });
    expect(updateArg).not.toHaveProperty('enabled');
  });

  it('throws when update step fails (#176)', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const eqName = vi.fn().mockResolvedValue({ error: { message: 'update failed' } });
    const eqOwner = vi.fn().mockReturnValue({ eq: eqName });
    const mockUpdatePayload = vi.fn().mockReturnValue({ eq: eqOwner });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFrom.mockImplementation((() => ({ upsert: mockUpsert, update: mockUpdatePayload })) as any);
    const { importRepos } = await import('./github-connections.js');
    await expect(importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]))
      .rejects.toThrow('Failed to import repository');
  });

  it('fires POST to DAEMON_URL/repos/reload after upserts (#166)', async () => {
    process.env.DAEMON_URL = 'http://localhost:7532';
    setupImportMock();
    const { importRepos } = await import('./github-connections.js');
    await importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:7532/repos/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Requested-By': 'dashboard' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('silently swallows fetch failure when daemon is unreachable (#166)', async () => {
    process.env.DAEMON_URL = 'http://localhost:9999';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    setupImportMock();
    const { importRepos } = await import('./github-connections.js');
    // Should not throw despite fetch failure
    await expect(importRepos('conn-1', [{ owner: 'acme', name: 'repo' }])).resolves.not.toThrow();
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
