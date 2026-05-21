import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    settings: {
      updateGlobalSettings: mocks.updateGlobalSettings,
    },
  }),
}));

import { revalidatePath } from 'next/cache';
import { requireDashboardAdmin } from '@/lib/auth/require-session';

import { updateGlobalSettings } from './settings';

describe('settings actions', () => {
  beforeEach(() => {
    mocks.requireDashboardAdmin.mockReset();
    mocks.updateGlobalSettings.mockReset();
    vi.mocked(revalidatePath).mockReset();
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
    mocks.updateGlobalSettings.mockResolvedValue({
      ok: true,
      value: { id: 'settings-1', concurrencyLimit: 5 },
    });
  });

  it('rejects non-admin users via the Better Auth admin gate', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await expect(updateGlobalSettings(formData)).rejects.toThrow(
      'Admin access required',
    );
    expect(mocks.updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('updates global settings through the app-owned settings store', async () => {
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await updateGlobalSettings(formData);

    expect(requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.updateGlobalSettings).toHaveBeenCalledWith({
      concurrencyLimit: 5,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
  });

  it('throws the existing load failure when the settings row is missing', async () => {
    mocks.updateGlobalSettings.mockResolvedValueOnce({
      ok: false,
      error: 'not-found',
      message: 'global settings were not found',
    });
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await expect(updateGlobalSettings(formData)).rejects.toThrow(
      'Failed to load settings',
    );
  });

  it('throws an update failure when the store is unavailable', async () => {
    mocks.updateGlobalSettings.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'connection refused',
    });
    const formData = new FormData();
    formData.append('concurrency_limit', '5');

    await expect(updateGlobalSettings(formData)).rejects.toThrow(
      'Failed to update settings',
    );
  });

  describe('concurrency_limit validation (#164)', () => {
    async function callWithLimit(value?: string) {
      const formData = new FormData();
      if (value !== undefined) formData.append('concurrency_limit', value);
      return updateGlobalSettings(formData);
    }

    const validationError =
      'Concurrency limit must be an integer between 1 and 20';

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
