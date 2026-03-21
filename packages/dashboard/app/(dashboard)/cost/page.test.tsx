vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CostPage from './page';
import { createClient } from '@/lib/supabase/server';

function mockSupabase(events: Record<string, unknown>[]) {
  vi.mocked(createClient).mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        gte: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: events, error: null }),
        }),
      }),
    }),
  } as never);
}

describe('CostPage', () => {
  it('displays per-repository cost breakdown (#83)', async () => {
    mockSupabase([
      { cost: 1.5, recorded_at: '2026-03-20T10:00:00Z', session_type: 'implementation', runs: { repo_name: 'web-app' } },
      { cost: 2.0, recorded_at: '2026-03-20T11:00:00Z', session_type: 'validation', runs: { repo_name: 'web-app' } },
      { cost: 0.5, recorded_at: '2026-03-20T12:00:00Z', session_type: 'planning', runs: { repo_name: 'api-server' } },
    ]);

    const jsx = await CostPage();
    render(jsx);

    expect(screen.getByText('By Repository')).toBeInTheDocument();
    expect(screen.getByText('web-app')).toBeInTheDocument();
    expect(screen.getByText('api-server')).toBeInTheDocument();
    // web-app: 1.5 + 2.0 = 3.5
    expect(screen.getByText('$3.5000')).toBeInTheDocument();
    // api-server: 0.5 (also appears in session type breakdown for planning)
    expect(screen.getAllByText('$0.5000').length).toBeGreaterThanOrEqual(1);
  });

  it('handles events with no linked run gracefully (#83)', async () => {
    mockSupabase([
      { cost: 1.0, recorded_at: '2026-03-20T10:00:00Z', session_type: 'planning', runs: null },
    ]);

    const jsx = await CostPage();
    render(jsx);

    expect(screen.getByText('By Repository')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('sorts repositories by cost descending (#83)', async () => {
    mockSupabase([
      { cost: 1.0, recorded_at: '2026-03-20T10:00:00Z', session_type: 'planning', runs: { repo_name: 'small-repo' } },
      { cost: 5.0, recorded_at: '2026-03-20T11:00:00Z', session_type: 'implementation', runs: { repo_name: 'big-repo' } },
    ]);

    const jsx = await CostPage();
    const { container } = render(jsx);

    // Scope to the By Repository card via data-testid
    const repoCard = container.querySelector('[data-testid="by-repo"]')!;
    const repoNames = repoCard.querySelectorAll('.text-muted-foreground');
    const names = Array.from(repoNames).map((el) => el.textContent);
    expect(names).toEqual(['big-repo', 'small-repo']);
  });
});
