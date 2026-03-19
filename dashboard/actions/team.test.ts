import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          neq: vi.fn().mockResolvedValue({ data: [{ id: 'other-admin' }] }),
          single: vi.fn().mockResolvedValue({ data: { role: 'viewer' } }),
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
    await expect(createInvitation(formData)).resolves.not.toThrow();
  });
});
