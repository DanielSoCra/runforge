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
});

describe('removeRepo', () => {
  beforeEach(() => {
    vi.resetModules();
    const { outer } = makeEqChain({ error: null });
    mockRepos.update.mockReturnValue({ eq: outer });
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
    const { outer } = makeEqChain({ error: { message: 'db error' } });
    mockRepos.update.mockReturnValue({ eq: outer });
    const { removeRepo } = await import('./github-connections.js');
    await expect(removeRepo('repo-1', 'conn-1')).rejects.toThrow('Failed to remove repository');
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

  it('accepts valid owner and name with dots, underscores, hyphens', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFrom.mockImplementation((() => ({ upsert: mockUpsert })) as any);
    const { importRepos } = await import('./github-connections.js');
    await importRepos('conn-1', [{ owner: 'my-org.test', name: 'repo_name-1' }]);
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('upserts repos with enabled=false per credential-first workflow (SPEC-4 regression)', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFrom.mockImplementation((() => ({ upsert: mockUpsert })) as any);
    const { importRepos } = await import('./github-connections.js');
    await importRepos('conn-1', [{ owner: 'acme', name: 'repo' }]);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      expect.any(Object),
    );
  });

  it('fires POST to DAEMON_URL/repos/reload after upserts (#166)', async () => {
    process.env.DAEMON_URL = 'http://localhost:7532';
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFrom.mockImplementation((() => ({ upsert: mockUpsert })) as any);
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
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFrom.mockImplementation((() => ({ upsert: mockUpsert })) as any);
    const { importRepos } = await import('./github-connections.js');
    // Should not throw despite fetch failure
    await expect(importRepos('conn-1', [{ owner: 'acme', name: 'repo' }])).resolves.not.toThrow();
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
