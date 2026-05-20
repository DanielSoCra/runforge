const mocks = vi.hoisted(() => ({
  readOverview: vi.fn(),
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    overview: { readOverview: mocks.readOverview },
  }),
}));

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from './page';

const originalDaemonUrl = process.env.DAEMON_URL;

describe('HomePage', () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T13:45:00Z'));
    process.env.DAEMON_URL = 'http://daemon.local';
    mocks.readOverview.mockReset();
    mocks.readOverview.mockResolvedValue({
      ok: true,
      value: {
        activeRuns: 2,
        todayCost: 12.345,
        totalRepos: 3,
        budgetByRepoId: { 'repo-1': 20 },
        recentRuns: [
          {
            id: 'run-1',
            repo_id: 'repo-1',
            repo_owner: 'acme',
            repo_name: 'web-app',
            issue_number: 484,
            issue_title: 'Investigate no-diff completion',
            pipeline_variant: 'standard',
            current_phase: 'validation',
            outcome: 'in-progress',
            total_cost: 4.25,
            phases: [],
            fix_attempts: 0,
            report: null,
            active_plugins: [],
            started_at: '2026-05-21T13:30:00.000Z',
            completed_at: null,
            updated_at: '2026-05-21T13:40:00.000Z',
          },
        ],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ state: 'paused' }),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalDaemonUrl === undefined) {
      delete process.env.DAEMON_URL;
    } else {
      process.env.DAEMON_URL = originalDaemonUrl;
    }
  });

  it('loads overview data from the app-owned store', async () => {
    const jsx = await HomePage();
    render(jsx);

    expect(mocks.readOverview).toHaveBeenCalledWith(
      new Date('2026-05-21T00:00:00.000Z'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'http://daemon.local/status',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(screen.getByText("Today's Cost (UTC)")).toBeInTheDocument();
    expect(screen.getByText('$12.35')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.getByText('acme/web-app')).toBeInTheDocument();
    expect(screen.getByText('#484')).toBeInTheDocument();
    expect(
      screen.getByText('Investigate no-diff completion'),
    ).toBeInTheDocument();
  });

  it('renders the daemon as offline when status cannot be fetched', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('offline'));

    const jsx = await HomePage();
    render(jsx);

    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('shows the page error when the overview store is unavailable', async () => {
    mocks.readOverview.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await HomePage();
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
