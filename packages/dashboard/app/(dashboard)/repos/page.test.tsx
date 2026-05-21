const storeMocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    repositories: { listRepositories: storeMocks.listRepositories },
  }),
}));

vi.mock('@/components/import-repos-modal', () => ({
  ImportReposModal: ({ connectionName }: { connectionName: string }) => (
    <button type="button">Import {connectionName}</button>
  ),
}));

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReposPage from './page';

describe('ReposPage', () => {
  beforeEach(() => {
    storeMocks.listRepositories.mockReset();
  });

  function mockReposPageStore({
    repos,
    connections = [],
    activeCostByRepoId = {},
  }: {
    repos: Record<string, unknown>[];
    connections?: Record<string, unknown>[];
    activeCostByRepoId?: Record<string, number>;
  }) {
    storeMocks.listRepositories.mockResolvedValue({
      ok: true,
      value: { repos, connections, activeCostByRepoId },
    });
  }

  it('shows repo-level budget warning when an active run reaches 80 percent of the repo budget', async () => {
    mockReposPageStore({
      repos: [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'web',
          enabled: true,
          budget_limit: 10,
          connection_id: null,
          github_connections: null,
          github_status: null,
          credential_status: 'ok',
          credential_error: null,
        },
      ],
      activeCostByRepoId: { 'repo-1': 8.5 },
    });

    const jsx = await ReposPage();
    render(jsx);

    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.getByText('80%+ budget')).toBeInTheDocument();
  });

  it('shows credential error status when daemon reports credential decryption failure (#445)', async () => {
    mockReposPageStore({
      repos: [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'web',
          enabled: true,
          budget_limit: null,
          connection_id: 'conn-1',
          github_connections: null,
          github_status: null,
          credential_status: 'error',
          credential_error: 'decrypt_github_token RPC failed',
        },
      ],
    });

    const jsx = await ReposPage();
    render(jsx);

    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.getByText('credential error')).toBeInTheDocument();
  });

  it('renders import controls from app-owned GitHub connection data', async () => {
    mockReposPageStore({
      connections: [
        {
          id: 'conn-1',
          display_name: 'Main GitHub',
          github_login: 'acme',
          status: 'active',
        },
      ],
      repos: [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'web',
          enabled: false,
          budget_limit: null,
          connection_id: 'conn-1',
          github_connections: {
            display_name: 'Main GitHub',
            github_login: 'acme',
          },
          github_status: 'ok',
          credential_status: 'ok',
          credential_error: null,
        },
      ],
    });

    const jsx = await ReposPage();
    render(jsx);

    expect(screen.getByRole('button', { name: 'Import Main GitHub' })).toBeInTheDocument();
    expect(screen.getByText('Main GitHub')).toBeInTheDocument();
  });

  it('shows the page error when the app-owned repository store is unavailable', async () => {
    storeMocks.listRepositories.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await ReposPage();
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
