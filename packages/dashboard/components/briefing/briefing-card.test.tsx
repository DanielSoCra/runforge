import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BriefingCard, type Briefing } from './briefing-card';

const mockBriefing: Briefing = {
  status_line: 'All systems nominal — 2 runs completed, 1 in progress.',
  changes: [
    {
      summary: 'Issue #42 moved to implementation',
      links: [
        { label: 'PR #43', url: 'https://github.com/acme/web/pull/43' },
      ],
    },
    {
      summary: 'Issue #50 specs approved',
      links: [],
    },
  ],
  attention: [
    {
      issueNumber: 99,
      reason: 'blocked',
      waitDuration: '3h',
      actionLinks: [
        { label: 'View issue', url: 'https://github.com/acme/web/issues/99' },
      ],
    },
  ],
  forecast: 'Expect Issue #50 to begin implementation within the next cycle.',
  generated_at: new Date().toISOString(),
};

describe('BriefingCard', () => {
  it('renders empty state when briefing is null', () => {
    render(<BriefingCard briefing={null} />);
    expect(screen.getByText('No briefing generated yet')).toBeInTheDocument();
  });

  it('renders status line', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    expect(
      screen.getByText('All systems nominal — 2 runs completed, 1 in progress.'),
    ).toBeInTheDocument();
  });

  it('renders changes with summaries', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    expect(screen.getByText('Issue #42 moved to implementation')).toBeInTheDocument();
    expect(screen.getByText('Issue #50 specs approved')).toBeInTheDocument();
  });

  it('renders change links as anchors with correct hrefs', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    const link = screen.getByText('PR #43');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/web/pull/43');
  });

  it('renders attention items with reason badge and issue number', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('#99')).toBeInTheDocument();
    expect(screen.getByText('waiting 3h')).toBeInTheDocument();
  });

  it('renders attention action links as anchors', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    const link = screen.getByText('View issue');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/acme/web/issues/99',
    );
  });

  it('renders forecast text', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    expect(
      screen.getByText(
        'Expect Issue #50 to begin implementation within the next cycle.',
      ),
    ).toBeInTheDocument();
  });

  it('shows stale badge when generated_at is older than 2x interval', () => {
    const staleBriefing: Briefing = {
      ...mockBriefing,
      generated_at: new Date(Date.now() - 700_000).toISOString(), // 700s ago
    };
    // With default intervalMs=300000 (5min), 2x = 600000 (10min).
    // 700s = 700000ms > 600000ms => stale
    render(<BriefingCard briefing={staleBriefing} />);
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('does not show stale badge when generated_at is recent', () => {
    render(<BriefingCard briefing={mockBriefing} />);
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });
});
