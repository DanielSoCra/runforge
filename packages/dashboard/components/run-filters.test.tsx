import { vi, describe, it, expect } from 'vitest';

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

import { render, screen } from '@testing-library/react';
import { RunFilters } from './run-filters';

const repos = [
  { id: 'repo-1', name: 'web', owner: 'acme' },
  { id: 'repo-2', name: 'api', owner: 'acme' },
];

describe('RunFilters', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockSearchParams = new URLSearchParams();
  });

  it('renders repo and outcome filter controls (#175)', () => {
    render(<RunFilters repos={repos} />);
    const container = screen.getByTestId('run-filters');
    expect(container).toBeInTheDocument();

    const repoTrigger = screen.getByLabelText('Filter by repository');
    expect(repoTrigger).toBeInTheDocument();

    const outcomeTrigger = screen.getByLabelText('Filter by outcome');
    expect(outcomeTrigger).toBeInTheDocument();
  });

  it('shows "All repos" and "All outcomes" as default placeholders (#175)', () => {
    render(<RunFilters repos={repos} />);
    expect(screen.getByText('All repos')).toBeInTheDocument();
    expect(screen.getByText('All outcomes')).toBeInTheDocument();
  });

  it('renders with empty repos list (#175)', () => {
    render(<RunFilters repos={[]} />);
    expect(screen.getByLabelText('Filter by repository')).toBeInTheDocument();
  });
});
