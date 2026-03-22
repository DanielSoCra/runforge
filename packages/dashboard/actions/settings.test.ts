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

  describe('concurrency_limit validation (#164)', () => {
    async function callWithLimit(value?: string) {
      vi.mocked(requireAdmin).mockResolvedValueOnce({ id: 'admin-1' } as never);
      const { updateGlobalSettings } = await import('./settings');
      const formData = new FormData();
      if (value !== undefined) formData.append('concurrency_limit', value);
      return updateGlobalSettings(formData);
    }

    const validationError = 'Concurrency limit must be an integer between 1 and 20';

    it('rejects non-numeric input', async () => {
      await expect(callWithLimit('abc')).rejects.toThrow(validationError);
    });

    it('rejects floating point numbers', async () => {
      await expect(callWithLimit('3.5')).rejects.toThrow(validationError);
    });

    it('rejects zero', async () => {
      await expect(callWithLimit('0')).rejects.toThrow(validationError);
    });

    it('rejects negative numbers', async () => {
      await expect(callWithLimit('-1')).rejects.toThrow(validationError);
    });

    it('rejects values above 20', async () => {
      await expect(callWithLimit('21')).rejects.toThrow(validationError);
    });

    it('rejects missing concurrency_limit field', async () => {
      await expect(callWithLimit()).rejects.toThrow(validationError);
    });

    it('accepts boundary value 1', async () => {
      await expect(callWithLimit('1')).resolves.not.toThrow();
    });

    it('accepts boundary value 20', async () => {
      await expect(callWithLimit('20')).resolves.not.toThrow();
    });
  });
});
