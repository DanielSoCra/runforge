import { describe, it, expect, vi } from 'vitest';

const mockRpc = vi.fn().mockResolvedValue({ error: null });

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn(),
    rpc: mockRpc,
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('upsertApiKey', () => {
  it('calls upsert_api_key_encrypted RPC — plaintext never stored directly in api_keys table', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'repo-123');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    await upsertApiKey(formData);

    // Verify encryption happens inside Postgres via RPC, not via direct table write
    expect(mockRpc).toHaveBeenCalledWith('upsert_api_key_encrypted', {
      p_repo_id: 'repo-123',
      p_key_type: 'source-control',
      p_plaintext: 'ghp_secrettoken',
    });
  });
});
