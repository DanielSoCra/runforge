import { describe, it, expect, vi, beforeEach } from 'vitest';

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
