const storeMocks = vi.hoisted(() => ({
  listBoardInputs: vi.fn(),
  readCredential: vi.fn(),
  requireDashboardUser: vi.fn(),
}));
vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardUser: storeMocks.requireDashboardUser,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    issues: { listBoardInputs: storeMocks.listBoardInputs },
    githubConnections: { readCredential: storeMocks.readCredential },
  }),
}));

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import IssuesPage from './page';

const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalFetch = global.fetch;

function mockBoardInputs(
  repos: Record<string, unknown>[] = [],
  runs: Record<string, unknown>[] = [],
) {
  storeMocks.listBoardInputs.mockResolvedValue({
    ok: true,
    value: { repos, runs },
  });
}

describe('IssuesPage', () => {
  beforeEach(() => {
    storeMocks.listBoardInputs.mockReset();
    storeMocks.readCredential.mockReset();
    storeMocks.requireDashboardUser.mockReset();
    storeMocks.requireDashboardUser.mockResolvedValue({
      user: { id: 'viewer-1', role: 'viewer' },
      session: {},
    });
    delete process.env.GITHUB_TOKEN;
    storeMocks.readCredential.mockResolvedValue({
      ok: false,
      error: 'not-found',
      message: 'missing connection',
    });
    mockBoardInputs();
  });

  afterEach(() => {
    if (originalGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGitHubToken;
    }
    global.fetch = originalFetch;
  });

  it('shows empty-state when no enabled repos exist (#129)', async () => {
    mockBoardInputs([], []);

    const jsx = await IssuesPage();
    render(jsx);

    expect(screen.getByText('No enabled repos found.')).toBeInTheDocument();
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
    const link = screen.getByText('Go to Settings').closest('a');
    expect(link).toHaveAttribute('href', '/settings');
  });

  it('shows empty-state when all repos lack GitHub tokens (#129)', async () => {
    const repos = [
      { id: '1', owner: 'acme', name: 'app', connectionId: null },
      { id: '2', owner: 'acme', name: 'lib', connectionId: null },
    ];
    mockBoardInputs(repos, []);

    const jsx = await IssuesPage();
    render(jsx);

    expect(screen.getByText(/None of your enabled repos have a GitHub token/)).toBeInTheDocument();
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
    expect(storeMocks.readCredential).not.toHaveBeenCalled();
  });

  it('reads connection credentials through the app-owned store', async () => {
    const repos = [
      { id: '1', owner: 'acme', name: 'app', connectionId: 'conn-1' },
    ];
    mockBoardInputs(repos, []);
    storeMocks.readCredential.mockResolvedValue({
      ok: true,
      value: { githubLogin: 'acme', token: 'ghp_faketoken123' },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }) as unknown as typeof fetch;

    await IssuesPage();

    expect(storeMocks.readCredential).toHaveBeenCalledWith('conn-1');
  });

  it('rejects unauthenticated users before decrypting tokens (#367)', async () => {
    mockBoardInputs([], []);
    storeMocks.requireDashboardUser.mockRejectedValueOnce(new Error('Unauthorized'));

    await expect(IssuesPage()).rejects.toThrow('Unauthorized');
    expect(storeMocks.listBoardInputs).not.toHaveBeenCalled();
    expect(storeMocks.readCredential).not.toHaveBeenCalled();
  });

  it('shows board when at least one repo has a GitHub token (#129)', async () => {
    const repos = [
      { id: '1', owner: 'acme', name: 'app', connectionId: 'conn-1' },
    ];
    mockBoardInputs(repos, []);
    storeMocks.readCredential.mockResolvedValue({
      ok: true,
      value: { githubLogin: 'acme', token: 'ghp_faketoken123' },
    });

    // Mock fetch for GitHub API
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }) as unknown as typeof fetch;

    const jsx = await IssuesPage();
    render(jsx);

    // Should show the board header, not the empty state
    expect(screen.getByText(/Open issues across 1 enabled repo/)).toBeInTheDocument();
    expect(screen.queryByText('Go to Settings')).not.toBeInTheDocument();
  });

  it('shows a page error when the app-owned issue store is unavailable', async () => {
    storeMocks.listBoardInputs.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await IssuesPage();
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
