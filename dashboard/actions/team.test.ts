import { describe, it, expect, vi } from 'vitest';

const mockInsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: mockInsert,
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { role: 'admin' } }),
          neq: vi.fn().mockResolvedValue({ data: [{ id: 'other-admin' }] }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('team actions', () => {
  it('createInvitation inserts with pending status', async () => {
    const { createInvitation } = await import('./team');
    const formData = new FormData();
    formData.append('provider_handle', 'octocat');
    formData.append('role', 'viewer');
    await createInvitation(formData);

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ provider_handle: 'octocat', status: 'pending' })
    );
  });
});
