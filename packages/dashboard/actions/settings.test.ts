import { describe, it, expect, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { role: 'viewer' } }),
        }),
      }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'viewer-1' } } }) },
  }),
}));

describe('settings actions', () => {
  it('rejects non-admin users with Admin access required', async () => {
    const { updateGlobalSettings } = await import('./settings');
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await expect(updateGlobalSettings(formData)).rejects.toThrow('Admin access required');
  });
});
