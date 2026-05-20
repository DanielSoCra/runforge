vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  readRunDetail: vi.fn(),
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    runs: { readRunDetail: mocks.readRunDetail },
  }),
}));

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import RunDetailPage from './page';
import { notFound } from 'next/navigation';

function mockRunDetail(
  runData: Record<string, unknown>,
  budgetLimit: number | null = null,
) {
  mocks.readRunDetail.mockResolvedValue({
    ok: true,
    value: {
      run: { ...baseRun, ...runData },
      budgetLimit,
    },
  });
}

const baseRun = {
  id: 'run-1',
  repo_id: 'repo-1',
  repo_owner: 'acme',
  repo_name: 'web',
  issue_number: 42,
  issue_title: 'Fix the thing',
  pipeline_variant: 'standard',
  current_phase: 'review',
  outcome: 'complete',
  phases: [],
  total_cost: 1.2345,
  fix_attempts: 0,
  report: null,
  active_plugins: [],
  started_at: '2026-05-21T12:00:00.000Z',
  completed_at: '2026-05-21T12:15:00.000Z',
  updated_at: '2026-05-21T12:15:00.000Z',
};

describe('RunDetailPage', () => {
  beforeEach(() => {
    mocks.readRunDetail.mockReset();
    vi.mocked(notFound).mockReset();
  });

  it('displays fix_attempts when greater than zero (#81)', async () => {
    mockRunDetail({ fix_attempts: 3 });
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('Fix attempts:')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('hides fix_attempts when zero (#81)', async () => {
    mockRunDetail({ fix_attempts: 0 });
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.queryByText('Fix attempts:')).not.toBeInTheDocument();
  });

  it('shows exceeded badge when cost exceeds budget (#84)', async () => {
    mockRunDetail({ total_cost: 12 }, 10);
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('Over budget')).toBeInTheDocument();
  });

  it('shows warning badge when cost is 80%+ of budget (#84)', async () => {
    mockRunDetail({ total_cost: 8.5 }, 10);
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('80%+ budget')).toBeInTheDocument();
  });

  it('displays active plugins when present (#127)', async () => {
    mockRunDetail({ active_plugins: ['nextjs-conventions', 'eslint-enforcer'] });
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('Active Plugins')).toBeInTheDocument();
    expect(screen.getByText('nextjs-conventions')).toBeInTheDocument();
    expect(screen.getByText('eslint-enforcer')).toBeInTheDocument();
  });

  it('hides active plugins section when empty (#127)', async () => {
    mockRunDetail({ active_plugins: [] });
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.queryByText('Active Plugins')).not.toBeInTheDocument();
  });

  it('shows no budget badge when under 80% (#84)', async () => {
    mockRunDetail({ total_cost: 5 }, 10);
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.queryByText('Over budget')).not.toBeInTheDocument();
    expect(screen.queryByText('80%+ budget')).not.toBeInTheDocument();
  });

  it('returns notFound when the app-owned run store has no matching run', async () => {
    mocks.readRunDetail.mockResolvedValueOnce({
      ok: false,
      error: 'not-found',
      message: 'run not found',
    });

    await RunDetailPage({ params: Promise.resolve({ id: 'run-missing' }) });

    expect(notFound).toHaveBeenCalled();
  });

  it('shows the page error when the app-owned run store is unavailable', async () => {
    mocks.readRunDetail.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
