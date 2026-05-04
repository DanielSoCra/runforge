vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

vi.mock('@/components/import-repos-modal', () => ({
  ImportReposModal: ({ connectionName }: { connectionName: string }) => (
    <button type="button">Import {connectionName}</button>
  ),
}));

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@/lib/supabase/server';
import ReposPage from './page';

describe('ReposPage', () => {
  function mockReposPageSupabase({
    repos,
    activeRuns = [],
  }: {
    repos: Record<string, unknown>[];
    activeRuns?: Record<string, unknown>[];
  }) {
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'repos') {
        return {
          select: vi.fn().mockReturnValue({
            is: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: repos, error: null }),
            }),
          }),
        };
      }
      if (table === 'github_connections') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'runs') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: activeRuns, error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    vi.mocked(createClient).mockResolvedValue({ from } as never);
  }

  it('shows repo-level budget warning when an active run reaches 80 percent of the repo budget', async () => {
    mockReposPageSupabase({
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
      activeRuns: [
        {
          repo_id: 'repo-1',
          total_cost: 8.5,
        },
      ],
    });

    const jsx = await ReposPage();
    render(jsx);

    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.getByText('80%+ budget')).toBeInTheDocument();
  });

  it('shows credential error status when daemon reports credential decryption failure (#445)', async () => {
    mockReposPageSupabase({
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
});
