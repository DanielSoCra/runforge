import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseApprovalPanel } from './release-approval-panel';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('ReleaseApprovalPanel', () => {
  it('posts to the daemon release proxy and shows the created PR link (#444)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'success',
        prNumber: 12,
        prUrl: 'https://github.com/DANIELSOCRAHANDLEZZ/runforge/pull/12',
      }), { status: 200 }),
    );

    render(<ReleaseApprovalPanel issueCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve production release' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/daemon/release', { method: 'POST' });
    });
    expect(await screen.findByText('Release proposal #12 created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open release PR' })).toHaveAttribute(
      'href',
      'https://github.com/DANIELSOCRAHANDLEZZ/runforge/pull/12',
    );
  });

  it('keeps approval disabled when there is no completed work', () => {
    render(<ReleaseApprovalPanel issueCount={0} />);

    expect(screen.getByRole('button', { name: 'Approve production release' })).toBeDisabled();
  });

  it('shows no-completed-work response from the daemon', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'no-completed-work' }), { status: 200 }),
    );

    render(<ReleaseApprovalPanel issueCount={1} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve production release' }));

    expect(await screen.findByText('No completed work is ready for release.')).toBeInTheDocument();
  });
});
