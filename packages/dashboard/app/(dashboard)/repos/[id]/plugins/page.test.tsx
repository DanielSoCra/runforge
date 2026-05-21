const mocks = vi.hoisted(() => ({
  isDashboardAdmin: vi.fn(),
  loadDashboardRegistry: vi.fn(),
  readRepositoryPlugins: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  isDashboardAdmin: mocks.isDashboardAdmin,
}));

vi.mock('@/lib/plugins/registry', () => ({
  loadDashboardRegistry: mocks.loadDashboardRegistry,
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    plugins: { readRepositoryPlugins: mocks.readRepositoryPlugins },
  }),
}));

vi.mock('./realtime-refresh', () => ({
  RealtimeRefresh: ({ repoId }: { repoId: string }) => (
    <div data-testid="realtime-refresh">{repoId}</div>
  ),
}));

vi.mock('@/components/repo-tab-nav', () => ({
  RepoTabNav: ({ repoId }: { repoId: string }) => (
    <div data-testid="repo-tab-nav">{repoId}</div>
  ),
}));

vi.mock('@/components/plugin-card', () => ({
  PluginCard: ({
    active,
    name,
    readOnly,
    recommendationReason,
  }: {
    active: boolean;
    name: string;
    readOnly: boolean;
    recommendationReason?: string | null;
  }) => (
    <article>
      <h4>{name}</h4>
      <span>{active ? 'active' : 'inactive'}</span>
      <span>{readOnly ? 'read-only' : 'editable'}</span>
      {recommendationReason && <p>{recommendationReason}</p>}
    </article>
  ),
}));

vi.mock('@/components/trigger-recommendation-button', () => ({
  TriggerRecommendationForm: () => <button type="button">Re-analyze</button>,
}));

vi.mock('@/components/enable-all-form', () => ({
  EnableAllForm: () => <button type="button">Enable all</button>,
}));

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PluginsPage from './page';

describe('PluginsPage', () => {
  beforeEach(() => {
    mocks.isDashboardAdmin.mockReset();
    mocks.loadDashboardRegistry.mockReset();
    mocks.readRepositoryPlugins.mockReset();
    mocks.isDashboardAdmin.mockResolvedValue(true);
    mocks.loadDashboardRegistry.mockResolvedValue({
      plugins: [
        {
          id: 'web-stack',
          name: 'Web Stack',
          description: 'Frontend conventions',
          tags: ['frontend'],
        },
        {
          id: 'api-tools',
          name: 'API Tools',
          description: 'API conventions',
          tags: ['backend'],
        },
      ],
    });
    mocks.readRepositoryPlugins.mockResolvedValue({
      ok: true,
      value: {
        repo: { id: 'repo-1', owner: 'acme', name: 'web' },
        plugins: [
          {
            plugin_id: 'web-stack',
            active: false,
            recommended: true,
            recommendation_reason: '[high] React app detected',
            recommended_at: '2026-05-21T00:00:00.000Z',
            activated_at: null,
          },
          {
            plugin_id: 'api-tools',
            active: true,
            recommended: false,
            recommendation_reason: null,
            recommended_at: null,
            activated_at: '2026-05-21T00:01:00.000Z',
          },
        ],
      },
    });
  });

  it('renders plugin sections from the app-owned plugin store', async () => {
    const jsx = await PluginsPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    expect(mocks.readRepositoryPlugins).toHaveBeenCalledWith('repo-1');
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Web Stack')).toBeInTheDocument();
    expect(screen.getByText('[high] React app detected')).toBeInTheDocument();
    expect(screen.getByText('API Tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable all' })).toBeInTheDocument();
  });

  it('renders plugin cards read-only for non-admin users', async () => {
    mocks.isDashboardAdmin.mockResolvedValueOnce(false);

    const jsx = await PluginsPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    expect(screen.queryByRole('button', { name: 'Re-analyze' })).not.toBeInTheDocument();
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0);
  });

  it('shows the page error when the plugin store is unavailable', async () => {
    mocks.readRepositoryPlugins.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await PluginsPage({ params: Promise.resolve({ id: 'repo-1' }) });
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
