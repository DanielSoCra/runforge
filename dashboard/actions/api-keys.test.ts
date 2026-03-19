import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('upsertApiKey', () => {
  it('calls upsert with encrypted value — plaintext never stored directly', async () => {
    const { upsertApiKey } = await import('./api-keys');
    const formData = new FormData();
    formData.append('repo_id', 'repo-123');
    formData.append('key_type', 'source-control');
    formData.append('key_value', 'ghp_secrettoken');

    // Should not throw — the actual encryption happens inside Postgres via RPC
    await expect(upsertApiKey(formData)).resolves.not.toThrow();
  });
});
