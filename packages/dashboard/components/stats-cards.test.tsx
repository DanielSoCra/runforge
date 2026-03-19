import { render, screen } from '@testing-library/react';
import { StatsCards } from './stats-cards';
import { describe, it, expect } from 'vitest';

describe('StatsCards', () => {
  it('renders stat cards with provided values', () => {
    render(
      <StatsCards
        activeRuns={3}
        todayCost={12.45}
        totalRepos={5}
        daemonStatus="running"
      />
    );
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('$12.45')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});
