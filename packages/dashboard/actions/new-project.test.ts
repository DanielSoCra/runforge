import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ error: null, data: { id: 'new-repo-id' } }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/github-api', () => ({
  createGitHubRepo: vi.fn().mockResolvedValue({ id: 1, name: 'test', html_url: 'https://github.com/acme/test', full_name: 'acme/test' }),
  commitFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createProject } from './new-project';
import { createGitHubRepo, commitFile } from '@/lib/github-api';

describe('createProject', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseInput = {
    org: 'acme',
    name: 'test',
    description: 'A test project',
    private: true,
    l0Vision: 'Build something great',
    baseProfile: 'default' as const,
  };

  let originalToken: string | undefined;
  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test';
  });
  afterEach(() => {
    process.env.GITHUB_TOKEN = originalToken;
  });

  it('creates GitHub repo using server-side GITHUB_TOKEN', async () => {
    await createProject(baseInput);
    expect(createGitHubRepo).toHaveBeenCalledWith('ghp_test', expect.objectContaining({ org: 'acme', name: 'test' }));
  });

  it('commits scaffold files', async () => {
    await createProject(baseInput);
    expect(vi.mocked(commitFile).mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('inserts Supabase repo record with enabled=false', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    await createProject(baseInput);
    const client = await (createClient as any)();
    expect(client.from().insert).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', name: 'test', enabled: false })
    );
  });

  it('returns repoId on success', async () => {
    const result = await createProject(baseInput);
    expect(result.repoId).toBe('new-repo-id');
  });

  it('returns error object when GitHub API fails', async () => {
    vi.mocked(createGitHubRepo).mockRejectedValueOnce(new Error('GitHub API error 422: name exists'));
    const result = await createProject(baseInput);
    expect(result.error).toContain('GitHub API error');
  });
});
