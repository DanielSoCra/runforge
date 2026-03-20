import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRepos = {
  update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
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
