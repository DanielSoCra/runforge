import { describe, it, expect, vi } from 'vitest';

// Mock Supabase client
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ error: null, data: { id: 'test-id' } }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

describe('repo actions', () => {
  it('createRepo inserts with enabled=false', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { createRepo } = await import('./repos');

    const formData = new FormData();
    formData.append('owner', 'acme');
    formData.append('name', 'web');
    formData.append('staging_branch', 'staging');
    formData.append('production_branch', 'main');
    formData.append('budget_limit', '10');
    formData.append('concurrency_limit', '1');

    await createRepo(formData);

    const client = await (createClient as any)();
    expect(client.from().insert).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', name: 'web', enabled: false })
    );
  });
});
