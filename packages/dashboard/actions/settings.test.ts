import { describe, it, expect, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn().mockResolvedValue({ id: 'admin-1' }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'settings-1' } }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
    auth: { getUser: vi.fn() },
  }),
}));

import { requireAdmin } from '@/lib/auth';

describe('settings actions', () => {
  it('rejects non-admin users via requireAdmin', async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('Admin access required'));
    const { updateGlobalSettings } = await import('./settings');
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await expect(updateGlobalSettings(formData)).rejects.toThrow('Admin access required');
  });

  it('calls shared requireAdmin instead of inline auth (regression #131)', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ id: 'admin-1' } as never);
    const { updateGlobalSettings } = await import('./settings');
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await updateGlobalSettings(formData);
    expect(requireAdmin).toHaveBeenCalled();
  });
});
