import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StatsCards } from './stats-cards';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

describe('StatsCards', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it('pauses the daemon from the running state', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ paused: true }), { status: 200 }),
    );

    render(
      <StatsCards
        activeRuns={3}
        todayCost={12.45}
        totalRepos={5}
        daemonStatus="running"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /pause daemon/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/daemon/pause', { method: 'POST' });
    });
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume daemon/i })).toBeInTheDocument();
  });

  it('resumes the daemon from the paused state', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ paused: false }), { status: 200 }),
    );

    render(
      <StatsCards
        activeRuns={0}
        todayCost={0}
        totalRepos={5}
        daemonStatus="paused"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /resume daemon/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/daemon/resume', { method: 'POST' });
    });
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause daemon/i })).toBeInTheDocument();
  });
});
