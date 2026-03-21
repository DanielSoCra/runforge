vi.mock('next/link', () => ({ default: ({ href, children, className }: any) => <a href={href} className={className}>{children}</a> }));

import { render, screen } from '@testing-library/react';
import { RunTable } from './run-table';
import { describe, it, expect } from 'vitest';

const mockRun = {
  id: 'run-1',
  repo_owner: 'acme',
  repo_name: 'web',
  issue_number: 42,
  issue_title: 'Fix login bug',
  outcome: 'complete' as const,
  total_cost: 0.1234,
  current_phase: 'done',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
};

describe('RunTable', () => {
  it('renders run rows with correct data', () => {
    render(<RunTable runs={[mockRun as any]} />);
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.getByText('$0.1234')).toBeInTheDocument();
  });

  it('renders empty state when no runs', () => {
    render(<RunTable runs={[]} />);
    expect(screen.getByText(/no runs/i)).toBeInTheDocument();
  });

  it('shows elapsed time for in-progress runs (#82)', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const inProgressRun = { ...mockRun, outcome: 'in-progress' as const, started_at: twoHoursAgo };
    render(<RunTable runs={[inProgressRun as any]} />);
    expect(screen.getByText(/^\d+h \d+m$/)).toBeInTheDocument();
  });

  it('shows absolute timestamp for completed runs (#82)', () => {
    const completedRun = { ...mockRun, outcome: 'complete' as const };
    render(<RunTable runs={[completedRun as any]} />);
    // Completed runs show locale string, not elapsed format
    expect(screen.queryByText(/^\d+h \d+m$/)).not.toBeInTheDocument();
  });

  it('renders Elapsed column header instead of Started (#82)', () => {
    render(<RunTable runs={[mockRun as any]} />);
    expect(screen.getByText('Elapsed')).toBeInTheDocument();
    expect(screen.queryByText('Started')).not.toBeInTheDocument();
  });
});
