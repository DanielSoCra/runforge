const mocks = vi.hoisted(() => ({
  listRunHistory: vi.fn(),
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    runs: { listRunHistory: mocks.listRunHistory },
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import RunsPage from './page';

function mockRunHistory() {
  mocks.listRunHistory.mockResolvedValue({
    ok: true,
    value: {
      runs: [],
      repos: [],
      budgetByRepoId: {},
    },
  });
}

function searchParams(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) };
}

describe('RunsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T13:45:00Z'));
    mocks.listRunHistory.mockReset();
    mockRunHistory();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies date range filter from searchParams (#86)', async () => {
    const jsx = await RunsPage(searchParams({ range: '7' }));
    render(jsx);

    expect(mocks.listRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({ since: expect.any(Date), limit: 100 }),
    );
    const queryDate = mocks.listRunHistory.mock.calls[0][0].since as Date;
    const now = new Date('2026-05-21T13:45:00Z');
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);

    // UI reflects selected range
    expect(screen.getByText(/Last 7 days/)).toBeInTheDocument();
  });

  it('defaults to 30 days when range param is missing (#86)', async () => {
    const jsx = await RunsPage(searchParams());
    render(jsx);

    const queryDate = mocks.listRunHistory.mock.calls[0][0].since as Date;
    const now = new Date('2026-05-21T13:45:00Z');
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);

    expect(screen.getByText(/Last 30 days/)).toBeInTheDocument();
  });

  it('defaults to 30 days when range param is invalid (#86)', async () => {
    const jsx = await RunsPage(searchParams({ range: '999' }));
    render(jsx);

    const queryDate = mocks.listRunHistory.mock.calls[0][0].since as Date;
    const now = new Date('2026-05-21T13:45:00Z');
    const diffDays = (now.getTime() - queryDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it('renders range selector with active state (#86)', async () => {
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
    const jsx = await RunsPage(searchParams({ repo: 'abc', outcome: 'complete', range: '7' }));
    const { container } = render(jsx);

    expect(mocks.listRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'abc', outcome: 'complete' }),
    );

    const selector = container.querySelector('[data-testid="range-selector"]')!;
    const links = Array.from(selector.querySelectorAll('a'));

    // All range links should preserve repo and outcome params
    for (const link of links) {
      const href = link.getAttribute('href')!;
      expect(href).toContain('repo=abc');
      expect(href).toContain('outcome=complete');
    }
  });

  it('shows the page error when the app-owned run store is unavailable', async () => {
    mocks.listRunHistory.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await RunsPage(searchParams());
    render(jsx);

    expect(screen.getByText(/Failed to load data/)).toBeInTheDocument();
  });
});
