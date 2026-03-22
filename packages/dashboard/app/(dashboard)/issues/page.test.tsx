vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IssuesPage from './page';
import { createClient } from '@/lib/supabase/server';

function mockSupabase(repos: Record<string, unknown>[] = [], runs: Record<string, unknown>[] = []) {
  const runsResolved = { data: runs, error: null };
  function runsChainable(): Record<string, ReturnType<typeof vi.fn>> {
    const obj: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['order', 'limit', 'eq']) {
      obj[method] = vi.fn().mockImplementation(() => runsChainable());
    }
    obj.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve(runsResolved));
    return obj;
  }

  const repoSelectFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      is: vi.fn().mockResolvedValue({ data: repos, error: null }),
    }),
  });

  const rpcFn = vi.fn().mockResolvedValue({ data: null });

  const fromFn = vi.fn((table: string) => {
    if (table === 'repos') return { select: repoSelectFn };
    if (table === 'runs') return { select: vi.fn().mockReturnValue(runsChainable()) };
    return { select: vi.fn() };
  });

  vi.mocked(createClient).mockResolvedValue({ from: fromFn, rpc: rpcFn } as never);
  return { rpcFn };
}

describe('IssuesPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  it('shows empty-state when no enabled repos exist (#129)', async () => {
    mockSupabase([], []);

    const jsx = await IssuesPage();
    render(jsx);

    expect(screen.getByText('No enabled repos found.')).toBeInTheDocument();
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
    const link = screen.getByText('Go to Settings').closest('a');
    expect(link).toHaveAttribute('href', '/settings');
  });

  it('shows empty-state when all repos lack GitHub tokens (#129)', async () => {
    const repos = [
      { id: '1', owner: 'acme', name: 'app', connection_id: null },
      { id: '2', owner: 'acme', name: 'lib', connection_id: null },
    ];
    mockSupabase(repos, []);

    const jsx = await IssuesPage();
    render(jsx);

    expect(screen.getByText(/None of your enabled repos have a GitHub token/)).toBeInTheDocument();
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
  });

  it('shows board when at least one repo has a GitHub token (#129)', async () => {
    const repos = [
      { id: '1', owner: 'acme', name: 'app', connection_id: 'conn-1' },
    ];
    const { rpcFn } = mockSupabase(repos, []);
    rpcFn.mockResolvedValue({ data: 'ghp_faketoken123' });

    // Mock fetch for GitHub API
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }) as unknown as typeof fetch;

    try {
      const jsx = await IssuesPage();
      render(jsx);

      // Should show the board header, not the empty state
      expect(screen.getByText(/Open issues across 1 enabled repo/)).toBeInTheDocument();
      expect(screen.queryByText('Go to Settings')).not.toBeInTheDocument();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
