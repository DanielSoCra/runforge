vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import RunDetailPage from './page';
import { createClient } from '@/lib/supabase/server';

function mockSupabase(runData: Record<string, unknown>, repoData: Record<string, unknown> | null = null) {
  vi.mocked(createClient).mockResolvedValue({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'repos') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: repoData, error: null }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: runData, error: null }),
          }),
        }),
      };
    }),
  } as never);
}

const baseRun = {
  id: 'run-1',
  repo_id: 'repo-1',
  repo_owner: 'acme',
  repo_name: 'web',
  issue_number: 42,
  issue_title: 'Fix the thing',
  outcome: 'success',
  phases: [],
  total_cost: 1.2345,
  fix_attempts: 0,
  report: null,
};

describe('RunDetailPage', () => {
  it('displays fix_attempts when greater than zero (#81)', async () => {
    mockSupabase({ ...baseRun, fix_attempts: 3 });
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('Fix attempts:')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('hides fix_attempts when zero (#81)', async () => {
    mockSupabase({ ...baseRun, fix_attempts: 0 });
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.queryByText('Fix attempts:')).not.toBeInTheDocument();
  });

  it('shows exceeded badge when cost exceeds budget (#84)', async () => {
    mockSupabase(
      { ...baseRun, total_cost: 12 },
      { budget_limit: 10 },
    );
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('Over budget')).toBeInTheDocument();
  });

  it('shows warning badge when cost is 80%+ of budget (#84)', async () => {
    mockSupabase(
      { ...baseRun, total_cost: 8.5 },
      { budget_limit: 10 },
    );
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.getByText('80%+ budget')).toBeInTheDocument();
  });

  it('shows no budget badge when under 80% (#84)', async () => {
    mockSupabase(
      { ...baseRun, total_cost: 5 },
      { budget_limit: 10 },
    );
    const jsx = await RunDetailPage({ params: Promise.resolve({ id: 'run-1' }) });
    render(jsx);

    expect(screen.queryByText('Over budget')).not.toBeInTheDocument();
    expect(screen.queryByText('80%+ budget')).not.toBeInTheDocument();
  });
});
