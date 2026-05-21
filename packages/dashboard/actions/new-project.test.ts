import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  createRepository: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    repositories: {
      createRepository: mocks.createRepository,
    },
  }),
}));
vi.mock('@/lib/github-api', () => ({
  createGitHubRepo: vi.fn().mockResolvedValue({
    id: 1,
    name: 'test',
    html_url: 'https://github.com/acme/test',
    full_name: 'acme/test',
  }),
  commitFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from 'next/cache';
import { requireDashboardAdmin } from '@/lib/auth/require-session';
import { commitFile, createGitHubRepo } from '@/lib/github-api';

import { createProject } from './new-project';

describe('createProject', () => {
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
    vi.clearAllMocks();
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test';
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
    mocks.createRepository.mockResolvedValue({
      ok: true,
      value: { id: 'new-repo-id' },
    });
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = originalToken;
  });

  it('requires a dashboard admin before creating anything', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );

    const result = await createProject(baseInput);

    expect(result.error).toBe('Unauthorized');
    expect(createGitHubRepo).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it('creates GitHub repo using server-side GITHUB_TOKEN', async () => {
    await createProject(baseInput);
    expect(requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(createGitHubRepo).toHaveBeenCalledWith(
      'ghp_test',
      expect.objectContaining({ org: 'acme', name: 'test' }),
    );
  });

  it('commits scaffold files', async () => {
    await createProject(baseInput);
    expect(vi.mocked(commitFile).mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('registers the repo through the app-owned repository store', async () => {
    await createProject(baseInput);
    expect(mocks.createRepository).toHaveBeenCalledWith({
      owner: 'acme',
      name: 'test',
      stagingBranch: 'staging',
      productionBranch: 'main',
      budgetLimit: null,
    });
  });

  it('returns repoId on success', async () => {
    const result = await createProject(baseInput);
    expect(result.repoId).toBe('new-repo-id');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
  });

  it('returns error object when GitHub API fails', async () => {
    vi.mocked(createGitHubRepo).mockRejectedValueOnce(
      new Error('GitHub API error 422: name exists'),
    );
    const result = await createProject(baseInput);
    expect(result.error).toBe('Failed to create project');
  });

  it('returns error when GITHUB_TOKEN is not configured', async () => {
    process.env.GITHUB_TOKEN = '';
    const result = await createProject(baseInput);
    expect(result.error).toContain('GITHUB_TOKEN');
    expect(createGitHubRepo).not.toHaveBeenCalled();
  });

  it('returns partial-failure error when GitHub repo was created but registration fails', async () => {
    mocks.createRepository.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'DB error',
    });
    const result = await createProject(baseInput);
    expect(result.error).toMatch(
      /GitHub repo was created but registration failed/,
    );
  });

  it('returns error when name contains invalid characters', async () => {
    const result = await createProject({ ...baseInput, name: 'my project!' });
    expect(result.error).toContain('Name must contain');
    expect(createGitHubRepo).not.toHaveBeenCalled();
  });

  it('returns error when l0Vision is empty', async () => {
    const result = await createProject({ ...baseInput, l0Vision: '  ' });
    expect(result.error).toContain('L0 vision');
    expect(createGitHubRepo).not.toHaveBeenCalled();
  });
});
