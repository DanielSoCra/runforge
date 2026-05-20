import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
const storeMocks = vi.hoisted(() => ({
  getDashboardStores: vi.fn(),
  storeRepoCredential: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: mockFrom,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
  }),
}));
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn().mockResolvedValue({ id: 'user-123' }) }));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: storeMocks.getDashboardStores,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { requireAdmin } from '@/lib/auth';

describe('upsertApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.storeRepoCredential.mockResolvedValue({ ok: true, value: undefined });
    storeMocks.getDashboardStores.mockReturnValue({
      credentials: { storeRepoCredential: storeMocks.storeRepoCredential },
    });
  });

  it('rejects non-admin callers', async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('Unauthorized'));
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await expect(upsertApiKey(formData)).rejects.toThrow('Unauthorized');
    expect(storeMocks.storeRepoCredential).not.toHaveBeenCalled();
  });

  it('stores repo credentials through the app-owned credential store', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await upsertApiKey(formData);

    expect(storeMocks.storeRepoCredential).toHaveBeenCalledWith(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      'source-control',
      'ghp_secrettoken',
    );

    expect(mockFrom).not.toHaveBeenCalled();
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
