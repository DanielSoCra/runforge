const mocks = vi.hoisted(() => ({
  getLatestBriefing: vi.fn(),
  daemonFetch: vi.fn(),
}));

vi.mock('@/actions/briefing', () => ({
  getLatestBriefing: mocks.getLatestBriefing,
}));

vi.mock('@/lib/daemon-fetch', () => ({
  daemonFetch: mocks.daemonFetch,
  DaemonConfigError: class DaemonConfigError extends Error {},
  DaemonAuthError: class DaemonAuthError extends Error {},
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SteeringPage from './page';

const briefing = {
  status_line: 'All systems nominal — 1 decision awaiting you.',
  changes: [],
  attention: [],
  forecast: 'Quiet cycle expected.',
  generated_at: new Date().toISOString(),
};

const pendingRows = [
  {
    decision_id: 'dec-001',
    status: 'notified',
    risk_class: 'P0',
    created_at: '2026-06-18T10:15:00.000Z',
    question: { kind: 'text', value: 'Merge PR #482 into main?' },
    score: 95,
    why_ranked: 'P0 risk, waiting 2h',
  },
];

describe('SteeringPage (operator surface)', () => {
  beforeEach(() => {
    cleanup();
    mocks.getLatestBriefing.mockReset();
    mocks.daemonFetch.mockReset();
    mocks.getLatestBriefing.mockResolvedValue(briefing);
    mocks.daemonFetch.mockResolvedValue(
      new Response(JSON.stringify({ items: pendingRows }), { status: 200 }),
    );
  });

  afterEach(() => cleanup());

  it('renders the calm pane: the briefing AND the decisions inbox', async () => {
    const jsx = await SteeringPage();
    render(jsx);

    // Briefing renders (its status line + AI Briefing card title).
    expect(screen.getByText('AI Briefing')).toBeInTheDocument();
    expect(
      screen.getByText('All systems nominal — 1 decision awaiting you.'),
    ).toBeInTheDocument();

    // Decisions inbox renders the ranked row.
    expect(screen.getByText('Merge PR #482 into main?')).toBeInTheDocument();
    expect(screen.getByText('P0')).toBeInTheDocument();
    // Pulled from the daemon Decision API via daemonFetch.
    expect(mocks.daemonFetch).toHaveBeenCalledWith(
      '/decisions/pending',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('shows ONLY decisions + briefing — no management content (StatsCards / RunTable)', async () => {
    const jsx = await SteeringPage();
    render(jsx);

    // Management surface (FUNC-AC-DASHBOARD) must NOT leak onto the operator surface.
    expect(screen.queryByText("Today's Cost (UTC)")).not.toBeInTheDocument();
    expect(screen.queryByText('Active Runs')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent Runs')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Repos')).not.toBeInTheDocument();
  });

  it('degrades calmly when the daemon Decision API is unreachable', async () => {
    mocks.daemonFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const jsx = await SteeringPage();
    render(jsx);

    // The briefing still renders; the inbox shows the calm degraded panel.
    expect(screen.getByText('AI Briefing')).toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
  });
});
