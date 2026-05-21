import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeMocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  storeRepoCredential: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: storeMocks.requireDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    credentials: { storeRepoCredential: storeMocks.storeRepoCredential },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from 'next/cache';
import { requireDashboardAdmin } from '@/lib/auth/require-session';

describe('upsertApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
    storeMocks.storeRepoCredential.mockResolvedValue({ ok: true, value: undefined });
  });

  it('rejects non-admin callers via the Better Auth admin gate', async () => {
    vi.mocked(requireDashboardAdmin).mockRejectedValueOnce(
      new Error('Admin access required'),
    );
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await expect(upsertApiKey(formData)).rejects.toThrow(
      'Admin access required',
    );
    expect(storeMocks.storeRepoCredential).not.toHaveBeenCalled();
  });

  it('stores repo credentials through the app-owned credential store', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await upsertApiKey(formData);

    expect(requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(storeMocks.storeRepoCredential).toHaveBeenCalledWith(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      'source-control',
      'ghp_secrettoken',
    );
    expect(revalidatePath).toHaveBeenCalledWith(
      '/repos/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
  });

  it('throws a generic error when the credential store fails', async () => {
    storeMocks.storeRepoCredential.mockResolvedValue({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await expect(upsertApiKey(formData)).rejects.toThrow(
      'Failed to save credential',
    );
  });

  it('throws for invalid key_type', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'INVALID_TYPE');
    formData.append('key_value', 'ghp_secrettoken');

    await expect(upsertApiKey(formData)).rejects.toThrow('Invalid key_type');
  });

  it('throws for empty key value', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', '');

    await expect(upsertApiKey(formData)).rejects.toThrow('Key value is required');
  });
});
