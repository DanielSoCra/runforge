import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  createRepository: vi.fn(),
  updateRepository: vi.fn(),
  setRepositoryEnabled: vi.fn(),
  removeRepository: vi.fn(),
  listRepoCredentialMetadata: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    repositories: {
      createRepository: mocks.createRepository,
      updateRepository: mocks.updateRepository,
      setRepositoryEnabled: mocks.setRepositoryEnabled,
      removeRepository: mocks.removeRepository,
    },
    credentials: {
      listRepoCredentialMetadata: mocks.listRepoCredentialMetadata,
    },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireDashboardAdmin } from '@/lib/auth/require-session';

import {
  createRepo,
  deleteRepo,
  disableRepo,
  enableRepo,
  updateRepo,
} from './repos';

describe('repo actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DAEMON_URL;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
    mocks.createRepository.mockResolvedValue({
      ok: true,
      value: { id: 'test-id' },
    });
    mocks.updateRepository.mockResolvedValue({ ok: true, value: undefined });
    mocks.setRepositoryEnabled.mockResolvedValue({
      ok: true,
      value: undefined,
    });
    mocks.removeRepository.mockResolvedValue({ ok: true, value: undefined });
    mocks.listRepoCredentialMetadata.mockResolvedValue({
      ok: true,
      value: [
        { key_type: 'source-control', updated_at: '2026-05-21T00:00:00.000Z' },
        { key_type: 'model-provider', updated_at: '2026-05-21T00:00:00.000Z' },
      ],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DAEMON_URL;
  });

  function validRepoForm(overrides: Record<string, string> = {}) {
    const formData = new FormData();
    formData.append('owner', overrides.owner ?? 'acme');
    formData.append('name', overrides.name ?? 'web');
    formData.append('staging_branch', overrides.staging_branch ?? 'staging');
    formData.append('production_branch', overrides.production_branch ?? 'main');
    formData.append('budget_limit', overrides.budget_limit ?? '10');
    formData.append('concurrency_limit', overrides.concurrency_limit ?? '1');
    return formData;
  }

  it('rejects non-admin callers before creating repositories', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );

    await expect(createRepo(validRepoForm())).rejects.toThrow(
      'Admin access required',
    );

    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it('createRepo writes through the app-owned repository store', async () => {
    await createRepo(validRepoForm());

    expect(requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.createRepository).toHaveBeenCalledWith({
      owner: 'acme',
      name: 'web',
      stagingBranch: 'staging',
      productionBranch: 'main',
      budgetLimit: 10,
      concurrencyLimit: 1,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
    expect(redirect).toHaveBeenCalledWith('/repos/test-id');
  });

  it('createRepo rejects non-numeric budget_limit before inserting', async () => {
    await expect(
      createRepo(validRepoForm({ budget_limit: 'abc' })),
    ).rejects.toThrow('Budget limit must be a valid non-negative number');
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it('createRepo rejects non-numeric concurrency_limit before inserting', async () => {
    await expect(
      createRepo(validRepoForm({ concurrency_limit: 'abc' })),
    ).rejects.toThrow('Concurrency limit must be a positive integer');
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it('createRepo throws when the store insert fails (#579)', async () => {
    mocks.createRepository.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'insert failed',
    });

    await expect(createRepo(validRepoForm())).rejects.toThrow(
      'Failed to create repository',
    );
  });

  it('updateRepo updates settings through the app-owned repository store', async () => {
    const formData = new FormData();
    formData.append('staging_branch', 'develop');
    formData.append('production_branch', 'main');
    formData.append('budget_limit', '50');
    formData.append('concurrency_limit', '3');

    await updateRepo('repo-1', formData);

    expect(mocks.updateRepository).toHaveBeenCalledWith('repo-1', {
      stagingBranch: 'develop',
      productionBranch: 'main',
      budgetLimit: 50,
      concurrencyLimit: 3,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/repos/repo-1');
  });

  it('updateRepo rejects non-numeric budget_limit before updating', async () => {
    await expect(
      updateRepo('repo-1', validRepoForm({ budget_limit: 'abc' })),
    ).rejects.toThrow('Budget limit must be a valid non-negative number');
    expect(mocks.updateRepository).not.toHaveBeenCalled();
  });

  it('updateRepo rejects non-numeric concurrency_limit before updating', async () => {
    await expect(
      updateRepo('repo-1', validRepoForm({ concurrency_limit: 'abc' })),
    ).rejects.toThrow('Concurrency limit must be a positive integer');
    expect(mocks.updateRepository).not.toHaveBeenCalled();
  });

  it('updateRepo defaults branches when not provided', async () => {
    await updateRepo('repo-1', new FormData());

    expect(mocks.updateRepository).toHaveBeenCalledWith('repo-1', {
      stagingBranch: 'staging',
      productionBranch: 'main',
      budgetLimit: null,
      concurrencyLimit: undefined,
    });
  });

  it('enableRepo rejects when credentials are missing', async () => {
    mocks.listRepoCredentialMetadata.mockResolvedValueOnce({
      ok: true,
      value: [],
    });

    await expect(enableRepo('repo-1')).rejects.toThrow(
      'Cannot enable repository without both source-control and model-provider credentials',
    );
    expect(mocks.setRepositoryEnabled).not.toHaveBeenCalled();
  });

  it('enableRepo rejects when only source-control key exists', async () => {
    mocks.listRepoCredentialMetadata.mockResolvedValueOnce({
      ok: true,
      value: [
        { key_type: 'source-control', updated_at: '2026-05-21T00:00:00.000Z' },
      ],
    });

    await expect(enableRepo('repo-1')).rejects.toThrow(
      'Cannot enable repository without both source-control and model-provider credentials',
    );
    expect(mocks.setRepositoryEnabled).not.toHaveBeenCalled();
  });

  it('enableRepo verifies credentials then enables through the repository store', async () => {
    await enableRepo('repo-1');

    expect(mocks.listRepoCredentialMetadata).toHaveBeenCalledWith('repo-1');
    expect(mocks.setRepositoryEnabled).toHaveBeenCalledWith('repo-1', true);
    expect(revalidatePath).toHaveBeenCalledWith('/repos/repo-1');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
  });

  it('enableRepo reloads daemon through normalized DAEMON_URL (#547)', async () => {
    process.env.DAEMON_URL = 'http://localhost:7532/';

    await enableRepo('repo-1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:7532/repos/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Requested-By': 'dashboard' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('enableRepo throws when credential verification fails', async () => {
    mocks.listRepoCredentialMetadata.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db unavailable',
    });

    await expect(enableRepo('repo-1')).rejects.toThrow(
      'Failed to verify repository credentials',
    );
    expect(mocks.setRepositoryEnabled).not.toHaveBeenCalled();
  });

  it('enableRepo throws when the repository update fails (#578)', async () => {
    mocks.setRepositoryEnabled.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db error',
    });

    await expect(enableRepo('repo-1')).rejects.toThrow(
      'Failed to enable repository',
    );
  });

  it('disableRepo sets enabled to false through the repository store', async () => {
    await disableRepo('repo-1');

    expect(mocks.setRepositoryEnabled).toHaveBeenCalledWith('repo-1', false);
    expect(revalidatePath).toHaveBeenCalledWith('/repos/repo-1');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
  });

  it('disableRepo reloads daemon through normalized DAEMON_URL (#547)', async () => {
    process.env.DAEMON_URL = 'http://localhost:7532/';

    await disableRepo('repo-1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:7532/repos/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Requested-By': 'dashboard' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('disableRepo throws on store error', async () => {
    mocks.setRepositoryEnabled.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db error',
    });

    await expect(disableRepo('repo-1')).rejects.toThrow(
      'Failed to disable repository',
    );
  });

  it('deleteRepo rejects deletion of an enabled repo', async () => {
    mocks.removeRepository.mockResolvedValueOnce({
      ok: false,
      error: 'conflict',
      message: 'enabled repositories must be disabled before removal',
    });

    await expect(deleteRepo('repo-1')).rejects.toThrow(
      'Cannot delete an enabled repository — disable it first',
    );
  });

  it('deleteRepo soft-deletes through the repository store', async () => {
    await deleteRepo('repo-1');

    expect(mocks.removeRepository).toHaveBeenCalledWith('repo-1');
    expect(revalidatePath).toHaveBeenCalledWith('/repos');
    expect(redirect).toHaveBeenCalledWith('/repos');
  });

  describe('createRepo SAFE_PATTERN validation', () => {
    it('rejects owner with path traversal characters', async () => {
      const formData = new FormData();
      formData.append('owner', '../etc');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens',
      );
    });

    it('rejects owner with spaces', async () => {
      const formData = new FormData();
      formData.append('owner', 'foo bar');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens',
      );
    });

    it('rejects owner with semicolons (injection)', async () => {
      const formData = new FormData();
      formData.append('owner', 'acme;rm');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens',
      );
    });

    it('rejects owner with backticks (injection)', async () => {
      const formData = new FormData();
      formData.append('owner', 'acme`whoami`');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Owner must contain only alphanumeric characters, dots, underscores, and hyphens',
      );
    });

    it('rejects name with slashes', async () => {
      const formData = new FormData();
      formData.append('owner', 'acme');
      formData.append('name', 'foo/bar');
      await expect(createRepo(formData)).rejects.toThrow(
        'Name must contain only alphanumeric characters, dots, underscores, and hyphens',
      );
    });

    it('rejects name with spaces', async () => {
      const formData = new FormData();
      formData.append('owner', 'acme');
      formData.append('name', 'foo bar');
      await expect(createRepo(formData)).rejects.toThrow(
        'Name must contain only alphanumeric characters, dots, underscores, and hyphens',
      );
    });

    it('rejects empty owner after trim', async () => {
      const formData = new FormData();
      formData.append('owner', '   ');
      formData.append('name', 'web');
      await expect(createRepo(formData)).rejects.toThrow(
        'Repository owner is required',
      );
    });

    it('rejects empty name after trim', async () => {
      const formData = new FormData();
      formData.append('owner', 'acme');
      formData.append('name', '   ');
      await expect(createRepo(formData)).rejects.toThrow(
        'Repository name is required',
      );
    });
  });
});
