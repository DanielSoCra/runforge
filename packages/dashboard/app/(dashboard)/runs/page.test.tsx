vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import RunsPage from './page';
import { createClient } from '@/lib/supabase/server';

function mockSupabase(runs: Record<string, unknown>[] = []) {
  // Create a chainable query object that supports any method order
  const resolved = { data: runs, error: null };
  function chainable(): Record<string, ReturnType<typeof vi.fn>> {
    const obj: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['gte', 'order', 'limit', 'eq']) {
      obj[method] = vi.fn().mockImplementation(() => chainable());
    }
    // Make it thenable so Promise.all resolves it
    obj.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve(resolved));
    return obj;
  }
  const gteFn = vi.fn().mockImplementation(() => chainable());
  const selectFn = vi.fn().mockReturnValue({ gte: gteFn });
  const repoSelectFn = vi.fn().mockReturnValue({
    is: vi.fn().mockResolvedValue({ data: [], error: null }),
  });
  const fromFn = vi.fn((table: string) => {
    if (table === 'runs') return { select: selectFn };
    if (table === 'repos') return { select: repoSelectFn };
    return { select: vi.fn() };
  });
  vi.mocked(createClient).mockResolvedValue({ from: fromFn } as never);
  return { gteFn, selectFn };
}

function searchParams(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) };
}

describe('RunsPage', () => {
  it('applies date range filter from searchParams (#86)', async () => {
    const { gteFn } = mockSupabase([]);

    const jsx = await RunsPage(searchParams({ range: '7' }));
    render(jsx);

    // Verify gte was called with started_at and a date ~7 days ago
    expect(gteFn).toHaveBeenCalledWith('started_at', expect.any(String));
    const isoDate = gteFn.mock.calls[0][1] as string;
    const queryDate = new Date(isoDate);
    const now = new Date();
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);

    // UI reflects selected range
    expect(screen.getByText(/Last 7 days/)).toBeInTheDocument();
  });

  it('defaults to 30 days when range param is missing (#86)', async () => {
    const { gteFn } = mockSupabase([]);

    const jsx = await RunsPage(searchParams());
    render(jsx);

    expect(gteFn).toHaveBeenCalledWith('started_at', expect.any(String));
    const isoDate = gteFn.mock.calls[0][1] as string;
    const queryDate = new Date(isoDate);
    const now = new Date();
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);

    expect(screen.getByText(/Last 30 days/)).toBeInTheDocument();
  });

  it('defaults to 30 days when range param is invalid (#86)', async () => {
    const { gteFn } = mockSupabase([]);

    const jsx = await RunsPage(searchParams({ range: '999' }));
    render(jsx);

    const isoDate = gteFn.mock.calls[0][1] as string;
    const queryDate = new Date(isoDate);
    const now = new Date();
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it('renders range selector with active state (#86)', async () => {
    mockSupabase([]);

    const jsx = await RunsPage(searchParams({ range: '90' }));
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

  it('preserves repo and outcome filters in range links (#86)', async () => {
    mockSupabase([]);

    const jsx = await RunsPage(searchParams({ repo: 'abc', outcome: 'complete', range: '7' }));
    const { container } = render(jsx);

    const selector = container.querySelector('[data-testid="range-selector"]')!;
    const links = Array.from(selector.querySelectorAll('a'));

    // All range links should preserve repo and outcome params
    for (const link of links) {
      const href = link.getAttribute('href')!;
      expect(href).toContain('repo=abc');
      expect(href).toContain('outcome=complete');
    }
  });
});
