const mocks = vi.hoisted(() => ({
  listCompletedRuns: vi.fn(),
  requireDashboardAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    runs: { listCompletedRuns: mocks.listCompletedRuns },
  }),
}));

vi.mock('@/components/release-approval-panel', () => ({
  ReleaseApprovalPanel: ({ issueCount }: { issueCount: number }) => (
    <button type="button" disabled={issueCount === 0}>
      Approve production release
    </button>
  ),
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReleasesPage from './page';

function mockCompletedRuns(runs: Record<string, unknown>[] = []) {
  mocks.listCompletedRuns.mockResolvedValue({ ok: true, value: runs });
}

describe('ReleasesPage', () => {
  beforeEach(() => {
    mocks.listCompletedRuns.mockReset();
    mocks.requireDashboardAdmin.mockReset();
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
      session: {},
    });
    mockCompletedRuns();
  });

  it('requires admin before loading pending release data', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );

    await expect(ReleasesPage()).rejects.toThrow('Admin access required');
    expect(mocks.listCompletedRuns).not.toHaveBeenCalled();
  });

  it('shows completed work ready for production with aggregated release notes (#444)', async () => {
    mockCompletedRuns([
      {
        id: 'run-1',
        repo_id: 'repo-1',
        issue_number: 519,
        repo_owner: 'DANIELSOCRAHANDLEZZ',
        repo_name: 'runforge',
        issue_title: 'Validate repo numeric fields',
        pipeline_variant: 'bug',
        current_phase: null,
        outcome: 'complete',
        total_cost: 1.25,
        phases: [],
        fix_attempts: 0,
        completed_at: '2026-05-04T16:36:23Z',
        report: 'Rejected invalid repo numeric fields before data mutations.',
        active_plugins: [],
        started_at: '2026-05-04T16:00:00Z',
        updated_at: '2026-05-04T16:36:23Z',
      },
    ]);

    const jsx = await ReleasesPage();
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Releases' })).toBeInTheDocument();
    expect(screen.getByText('#519')).toBeInTheDocument();
    expect(screen.getByText('DANIELSOCRAHANDLEZZ/runforge')).toBeInTheDocument();
    expect(screen.getByText('Validate repo numeric fields')).toBeInTheDocument();
    expect(screen.getByText('Release Notes')).toBeInTheDocument();
    expect(screen.getByText('Issues completed: 1')).toBeInTheDocument();
    expect(screen.getByText('Total cost: $1.25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve production release' })).toBeEnabled();
  });

  it('shows an empty state and disables approval when no completed work exists (#444)', async () => {
    mockCompletedRuns([]);

    const jsx = await ReleasesPage();
    render(jsx);

    expect(screen.getByText('No completed work is ready for production.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve production release' })).toBeDisabled();
  });

  it('shows the page error when the app-owned run store is unavailable', async () => {
    mocks.listCompletedRuns.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await ReleasesPage();
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
