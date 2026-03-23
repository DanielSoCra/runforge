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

  it('enableRepo rejects when credentials are missing', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { enableRepo } = await import('./repos');

    const client = await (createClient as any)();
    // First call: from('team_members') for requireAdmin
    // Second call: from('api_keys') for credential check — returns no keys
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });

    await expect(enableRepo('repo-1')).rejects.toThrow(
      'Cannot enable repository without both source-control and model-provider credentials'
    );
  });

  it('enableRepo rejects when only source-control key exists', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { enableRepo } = await import('./repos');

    const client = await (createClient as any)();
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ key_type: 'source-control' }],
          error: null,
        }),
      }),
    });

    await expect(enableRepo('repo-1')).rejects.toThrow(
      'Cannot enable repository without both source-control and model-provider credentials'
    );
  });

  it('enableRepo succeeds when both credentials exist', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { enableRepo } = await import('./repos');

    const client = await (createClient as any)();
    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    // First call: requireAdmin
    // Second call: api_keys credential check — both keys present
    // Third call: repos update
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [
            { key_type: 'source-control' },
            { key_type: 'model-provider' },
          ],
          error: null,
        }),
      }),
    }).mockReturnValueOnce({
      update: updateMock,
    });

    await enableRepo('repo-1');

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it('updateRepo updates settings for a repo', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { updateRepo } = await import('./repos');

    const client = await (createClient as any)();
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      update: updateMock,
    });

    const formData = new FormData();
    formData.append('staging_branch', 'develop');
    formData.append('production_branch', 'main');
    formData.append('budget_limit', '50');
    formData.append('concurrency_limit', '3');

    await updateRepo('repo-1', formData);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staging_branch: 'develop',
        production_branch: 'main',
        budget_limit: 50,
        concurrency_limit: 3,
        updated_at: expect.any(String),
      })
    );
    expect(eqMock).toHaveBeenCalledWith('id', 'repo-1');
  });

  it('updateRepo defaults branches when not provided', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { updateRepo } = await import('./repos');

    const client = await (createClient as any)();
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      update: updateMock,
    });

    const formData = new FormData();

    await updateRepo('repo-1', formData);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staging_branch: 'staging',
        production_branch: 'main',
        budget_limit: null,
        concurrency_limit: undefined,
      })
    );
    expect(eqMock).toHaveBeenCalledWith('id', 'repo-1');
  });

  it('disableRepo sets enabled to false', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { disableRepo } = await import('./repos');

    const client = await (createClient as any)();
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      update: updateMock,
    });

    await disableRepo('repo-1');

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, updated_at: expect.any(String) })
    );
    expect(eqMock).toHaveBeenCalledWith('id', 'repo-1');
  });

  it('disableRepo throws on supabase error', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { disableRepo } = await import('./repos');

    const client = await (createClient as any)();
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: 'db error' } }),
      }),
    });

    await expect(disableRepo('repo-1')).rejects.toThrow('Failed to disable repository');
  });

  it('deleteRepo rejects deletion of an enabled repo', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { deleteRepo } = await import('./repos');

    const client = await (createClient as any)();
    // Override select chain to return enabled: true
    const selectChain = {
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { enabled: true }, error: null }),
      }),
    };
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      select: vi.fn().mockReturnValue(selectChain),
    });

    await expect(deleteRepo('repo-1')).rejects.toThrow(
      'Cannot delete an enabled repository — disable it first'
    );
  });

  describe('createRepo SAFE_PATTERN validation', () => {
    it('rejects owner with path traversal characters', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', '../etc');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens'
      );
    });

    it('rejects owner with spaces', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', 'foo bar');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens'
      );
    });

    it('rejects owner with semicolons (injection)', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', 'acme;rm');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens'
      );
    });

    it('rejects owner with backticks (injection)', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', 'acme`whoami`');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens'
      );
    });

    it('rejects name with slashes', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', 'acme');
      formData.append('name', 'foo/bar');
      await expect(createRepo(formData)).rejects.toThrow(
        'Name must contain only alphanumeric characters, dots, underscores, and hyphens'
      );
    });

    it('rejects name with spaces', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', 'acme');
      formData.append('name', 'foo bar');
      await expect(createRepo(formData)).rejects.toThrow(
        'Name must contain only alphanumeric characters, dots, underscores, and hyphens'
      );
    });

    it('rejects empty owner after trim', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', '   ');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Repository owner is required'
      );
    });

    it('rejects empty name after trim', async () => {
      const { createRepo } = await import('./repos');
      const formData = new FormData();
      formData.append('owner', 'acme');
      formData.append('name', '   ');
      await expect(createRepo(formData)).rejects.toThrow(
        'Repository name is required'
      );
    });
  });

  it('deleteRepo succeeds for a disabled repo', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { deleteRepo } = await import('./repos');

    const client = await (createClient as any)();
    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    // First call: from('team_members') for requireAdmin
    // Second call: from('repos').select('enabled') for precondition check
    // Third call: from('repos').update(...) for the actual soft-delete
    client.from.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }).mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { enabled: false }, error: null }),
        }),
      }),
    }).mockReturnValueOnce({
      update: updateMock,
    });

    await deleteRepo('repo-1');

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, deleted_at: expect.any(String) })
    );
  });
});
