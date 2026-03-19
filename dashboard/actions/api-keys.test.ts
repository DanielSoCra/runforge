import { describe, it, expect, vi } from 'vitest';

const mockRpc = vi.fn().mockResolvedValue({ error: null });
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: mockFrom,
    rpc: mockRpc,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('upsertApiKey', () => {
  it('calls upsert_api_key_encrypted RPC — plaintext never stored directly in api_keys table', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await upsertApiKey(formData);

    // Verify encryption happens inside Postgres via RPC, not via direct table write
    expect(mockRpc).toHaveBeenCalledWith('upsert_api_key_encrypted', {
      p_repo_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      p_key_type: 'source-control',
      p_plaintext: 'ghp_secrettoken',
    });

    // Critical: api_keys table must never be accessed directly
    expect(mockFrom).not.toHaveBeenCalled();
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
