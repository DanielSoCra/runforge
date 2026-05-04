vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAdmin: vi.fn(),
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
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

function mockSupabase(runs: Record<string, unknown>[] = []) {
  const limitFn = vi.fn().mockResolvedValue({ data: runs, error: null });
  const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
  const eqFn = vi.fn().mockReturnValue({ order: orderFn });
  const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
  const fromFn = vi.fn().mockReturnValue({ select: selectFn });
  vi.mocked(createClient).mockResolvedValue({ from: fromFn } as never);
  return { fromFn, eqFn };
}

describe('ReleasesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires admin before loading pending release data', async () => {
    const { fromFn } = mockSupabase([]);
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('Admin access required'));

    await expect(ReleasesPage()).rejects.toThrow('Admin access required');
    expect(fromFn).not.toHaveBeenCalled();
  });

  it('shows completed work ready for production with aggregated release notes (#444)', async () => {
    mockSupabase([
      {
        issue_number: 519,
        repo_owner: 'DANIELSOCRAHANDLEZZ',
        repo_name: 'auto-claude',
        issue_title: 'Validate repo numeric fields',
        pipeline_variant: 'bug',
        total_cost: 1.25,
        completed_at: '2026-05-04T16:36:23Z',
        report: 'Rejected invalid repo numeric fields before Supabase mutations.',
      },
    ]);

    const jsx = await ReleasesPage();
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Releases' })).toBeInTheDocument();
    expect(screen.getByText('#519')).toBeInTheDocument();
    expect(screen.getByText('DANIELSOCRAHANDLEZZ/auto-claude')).toBeInTheDocument();
    expect(screen.getByText('Validate repo numeric fields')).toBeInTheDocument();
    expect(screen.getByText('Release Notes')).toBeInTheDocument();
    expect(screen.getByText('Issues completed: 1')).toBeInTheDocument();
    expect(screen.getByText('Total cost: $1.25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve production release' })).toBeEnabled();
  });

  it('shows an empty state and disables approval when no completed work exists (#444)', async () => {
    mockSupabase([]);

    const jsx = await ReleasesPage();
    render(jsx);

    expect(screen.getByText('No completed work is ready for production.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve production release' })).toBeDisabled();
  });
});
