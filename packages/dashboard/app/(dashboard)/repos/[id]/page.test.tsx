vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'repos') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'repo-1',
                  owner: 'acme',
                  name: 'web',
                  enabled: true,
                  deleted_at: null,
                  staging_branch: 'staging',
                  production_branch: 'main',
                  budget_limit: 5.0,
                  concurrency_limit: 2,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'api_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { key_type: 'source-control', updated_at: '2026-01-01' },
                { key_type: 'model-provider', updated_at: '2026-01-01' },
              ],
              error: null,
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    }),
  }),
}));

vi.mock('@/lib/auth', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/actions/repos', () => ({
  enableRepo: vi.fn(),
  disableRepo: vi.fn(),
  deleteRepo: vi.fn(),
  updateRepo: { bind: vi.fn().mockReturnValue('bound-updateRepo') },
}));

vi.mock('@/actions/api-keys', () => ({
  upsertApiKey: vi.fn(),
}));

vi.mock('@/components/repo-tab-nav', () => ({
  RepoTabNav: () => <div data-testid="repo-tab-nav" />,
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import RepoDetailPage from './page';

describe('RepoDetailPage', () => {
  it('renders settings form with branch, budget, and concurrency fields (#78)', async () => {
    const jsx = await RepoDetailPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    // Settings card exists
    expect(screen.getByText('Settings')).toBeInTheDocument();

    // Branch fields pre-filled
    const stagingInput = screen.getByLabelText('Staging Branch') as HTMLInputElement;
    expect(stagingInput).toBeInTheDocument();
    expect(stagingInput.defaultValue).toBe('staging');

    const prodInput = screen.getByLabelText('Production Branch') as HTMLInputElement;
    expect(prodInput).toBeInTheDocument();
    expect(prodInput.defaultValue).toBe('main');

    // Budget and concurrency fields pre-filled
    const budgetInput = screen.getByLabelText('Budget Limit ($)') as HTMLInputElement;
    expect(budgetInput).toBeInTheDocument();
    expect(budgetInput.defaultValue).toBe('5');

    const concurrencyInput = screen.getByLabelText('Concurrency Limit') as HTMLInputElement;
    expect(concurrencyInput).toBeInTheDocument();
    expect(concurrencyInput.defaultValue).toBe('2');

    // Save button exists
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeInTheDocument();
  });

  it('does not render settings form for non-admin users (#78)', async () => {
    const { isAdmin } = await import('@/lib/auth');
    vi.mocked(isAdmin).mockResolvedValueOnce(false);

    const jsx = await RepoDetailPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Staging Branch')).not.toBeInTheDocument();
  });
});
