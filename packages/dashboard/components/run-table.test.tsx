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
});
