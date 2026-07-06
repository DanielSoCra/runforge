import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
}));

vi.mock('@/actions/github-connections', () => ({
  removeConnection: vi.fn(),
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    githubConnections: {
      listConnections: mocks.listConnections,
    },
  }),
}));

beforeEach(() => {
  cleanup();
  mocks.listConnections.mockReset();
  mocks.listConnections.mockResolvedValue({ ok: true, value: [] });
});

describe('GitHubConnectionsSection', () => {
  it('renders connected accounts from the app-owned store', async () => {
    mocks.listConnections.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          id: 'conn-1',
          displayName: 'Primary GitHub',
          githubLogin: 'octocat',
          avatarUrl: 'https://example.test/avatar.png',
          status: 'active',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          organizations: [{ login: 'runforge' }, { login: 'tools' }],
        },
      ],
    });
    const { GitHubConnectionsSection } = await import(
      './github-connections-section'
    );

    render(await GitHubConnectionsSection());

    expect(screen.getByText('Primary GitHub')).toBeInTheDocument();
    expect(screen.getByText('runforge, tools')).toBeInTheDocument();
    expect(screen.getByAltText('octocat')).toHaveAttribute(
      'src',
      'https://example.test/avatar.png',
    );
    expect(screen.getByRole('link', { name: /Re-authorize/ })).toHaveAttribute(
      'href',
      '/api/auth/github-connection?reauthorize=conn-1',
    );
  });

  it('keeps the existing empty state when no accounts exist', async () => {
    const { GitHubConnectionsSection } = await import(
      './github-connections-section'
    );

    render(await GitHubConnectionsSection());

    expect(
      screen.getByText('No GitHub accounts connected.'),
    ).toBeInTheDocument();
  });

  it('shows an explicit unavailable state when the store cannot be read', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listConnections.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'connection refused',
    });
    const { GitHubConnectionsSection } = await import(
      './github-connections-section'
    );

    render(await GitHubConnectionsSection());

    expect(
      screen.getByText('GitHub connections unavailable.'),
    ).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[github-connections] failed to load connections:',
      'connection refused',
    );
    consoleSpy.mockRestore();
  });
});
