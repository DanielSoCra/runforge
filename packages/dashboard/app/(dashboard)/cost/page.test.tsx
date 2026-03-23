vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CostPage from './page';
import { createClient } from '@/lib/supabase/server';

function mockSupabase(events: Record<string, unknown>[]) {
  const gteFn = vi.fn().mockReturnValue({
    order: vi.fn().mockResolvedValue({ data: events, error: null }),
  });
  vi.mocked(createClient).mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        gte: gteFn,
      }),
    }),
  } as never);
  return { gteFn };
}

function searchParams(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) };
}

describe('CostPage', () => {
  it('displays per-repository cost breakdown (#83)', async () => {
    mockSupabase([
      { cost: 1.5, recorded_at: '2026-03-20T10:00:00Z', session_type: 'implementation', runs: { repo_owner: 'acme', repo_name: 'web-app' } },
      { cost: 2.0, recorded_at: '2026-03-20T11:00:00Z', session_type: 'validation', runs: { repo_owner: 'acme', repo_name: 'web-app' } },
      { cost: 0.5, recorded_at: '2026-03-20T12:00:00Z', session_type: 'planning', runs: { repo_owner: 'acme', repo_name: 'api-server' } },
    ]);

    const jsx = await CostPage(searchParams());
    render(jsx);

    expect(screen.getByText('By Repository')).toBeInTheDocument();
    expect(screen.getByText('acme/web-app')).toBeInTheDocument();
    expect(screen.getByText('acme/api-server')).toBeInTheDocument();
    // web-app: 1.5 + 2.0 = 3.5
    expect(screen.getByText('$3.5000')).toBeInTheDocument();
    // api-server: 0.5 (also appears in session type breakdown for planning)
    expect(screen.getAllByText('$0.5000').length).toBeGreaterThanOrEqual(1);
  });

  it('handles events with no linked run gracefully (#83)', async () => {
    mockSupabase([
      { cost: 1.0, recorded_at: '2026-03-20T10:00:00Z', session_type: 'planning', runs: null },
    ]);

    const jsx = await CostPage(searchParams());
    render(jsx);

    expect(screen.getByText('By Repository')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('sorts repositories by cost descending (#83)', async () => {
    mockSupabase([
      { cost: 1.0, recorded_at: '2026-03-20T10:00:00Z', session_type: 'planning', runs: { repo_owner: 'acme', repo_name: 'small-repo' } },
      { cost: 5.0, recorded_at: '2026-03-20T11:00:00Z', session_type: 'implementation', runs: { repo_owner: 'acme', repo_name: 'big-repo' } },
    ]);

    const jsx = await CostPage(searchParams());
    const { container } = render(jsx);

    // Scope to the By Repository card via data-testid
    const repoCard = container.querySelector('[data-testid="by-repo"]')!;
    const repoNames = repoCard.querySelectorAll('.text-muted-foreground');
    const names = Array.from(repoNames).map((el) => el.textContent);
    expect(names).toEqual(['acme/big-repo', 'acme/small-repo']);
  });

  it('uses selected time range from searchParams (#87)', async () => {
    const { gteFn } = mockSupabase([
      { cost: 1.0, recorded_at: '2026-03-20T10:00:00Z', session_type: 'planning', runs: { repo_owner: 'acme', repo_name: 'repo-a' } },
    ]);

    const jsx = await CostPage(searchParams({ range: '7' }));
    render(jsx);

    // Verify the query uses ~7-day window (gte arg should be ~7 days ago)
    expect(gteFn).toHaveBeenCalledWith('recorded_at', expect.any(String));
    const isoDate = gteFn.mock.calls[0][1] as string;
    const queryDate = new Date(isoDate);
    const now = new Date();
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);

    // UI reflects selected range
    expect(screen.getByText(/Last 7 days/)).toBeInTheDocument();
  });

  it('renders range selector with active state (#87)', async () => {
    mockSupabase([]);

    const jsx = await CostPage(searchParams({ range: '90' }));
    const { container } = render(jsx);

    const selector = container.querySelector('[data-testid="range-selector"]')!;
    expect(selector).toBeInTheDocument();

    const links = selector.querySelectorAll('a');
    expect(links).toHaveLength(3);

    // 90d link should have the active class
    const link90 = Array.from(links).find((l) => l.textContent === '90d')!;
    expect(link90.className).toContain('bg-primary');

    // 7d link should not have the active class
    const link7 = Array.from(links).find((l) => l.textContent === '7d')!;
    expect(link7.className).not.toContain('bg-primary');
  });

  it('separates costs for same-name repos from different owners (#290)', async () => {
    mockSupabase([
      { cost: 3.0, recorded_at: '2026-03-20T10:00:00Z', session_type: 'implementation', runs: { repo_owner: 'org-a', repo_name: 'api' } },
      { cost: 7.0, recorded_at: '2026-03-20T11:00:00Z', session_type: 'implementation', runs: { repo_owner: 'org-b', repo_name: 'api' } },
    ]);

    const jsx = await CostPage(searchParams());
    render(jsx);

    expect(screen.getByText('org-a/api')).toBeInTheDocument();
    expect(screen.getByText('org-b/api')).toBeInTheDocument();
    expect(screen.getByText('$3.0000')).toBeInTheDocument();
    expect(screen.getByText('$7.0000')).toBeInTheDocument();
  });

  it('defaults to 30 days when range param is invalid (#87)', async () => {
    const { gteFn } = mockSupabase([]);

    const jsx = await CostPage(searchParams({ range: '999' }));
    render(jsx);

    expect(gteFn).toHaveBeenCalledWith('recorded_at', expect.any(String));
    const isoDate = gteFn.mock.calls[0][1] as string;
    const queryDate = new Date(isoDate);
    const now = new Date();
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);

    expect(screen.getByText(/Last 30 days/)).toBeInTheDocument();
  });
});
