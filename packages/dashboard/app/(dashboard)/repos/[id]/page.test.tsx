const mocks = vi.hoisted(() => ({
  isDashboardAdmin: vi.fn(),
  readRepository: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  isDashboardAdmin: mocks.isDashboardAdmin,
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    repositories: { readRepository: mocks.readRepository },
  }),
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
import { beforeEach, describe, it, expect, vi } from 'vitest';
import RepoDetailPage from './page';

describe('RepoDetailPage', () => {
  beforeEach(() => {
    mocks.isDashboardAdmin.mockReset();
    mocks.readRepository.mockReset();
    mocks.isDashboardAdmin.mockResolvedValue(true);
    mocks.readRepository.mockResolvedValue({
      ok: true,
      value: {
        repo: {
          id: 'repo-1',
          owner: 'acme',
          name: 'web',
          enabled: true,
          staging_branch: 'staging',
          production_branch: 'main',
          budget_limit: 5.0,
          concurrency_limit: 2,
        },
        credentials: [
          { key_type: 'source-control', updated_at: '2026-01-01T00:00:00.000Z' },
          { key_type: 'model-provider', updated_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });
  });

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
    mocks.isDashboardAdmin.mockResolvedValueOnce(false);

    const jsx = await RepoDetailPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Staging Branch')).not.toBeInTheDocument();
  });

  it('shows the page error when the app-owned repository store is unavailable', async () => {
    mocks.readRepository.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await RepoDetailPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
