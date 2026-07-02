// G1 gate: /steering must mount a periodic client refresher that calls router.refresh().
const mocks = vi.hoisted(() => ({
  daemonFetch: vi.fn(),
  getLatestBriefing: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/actions/briefing', () => ({
  getLatestBriefing: mocks.getLatestBriefing,
}));

vi.mock('@/lib/daemon-fetch', () => ({
  daemonFetch: mocks.daemonFetch,
  DaemonConfigError: class DaemonConfigError extends Error {},
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SteeringPage from '../../app/(dashboard)/steering/page';

const briefing = {
  status_line: 'Quiet cycle.',
  changes: [],
  attention: [],
  forecast: 'No intervention expected.',
  generated_at: '2026-07-02T10:00:00.000Z',
};

describe('P3 G1 live steering inbox gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_REFRESH_INTERVAL_MS', '25');
    mocks.refresh.mockReset();
    mocks.getLatestBriefing.mockReset();
    mocks.daemonFetch.mockReset();
    mocks.getLatestBriefing.mockResolvedValue(briefing);
    mocks.daemonFetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('refreshes the steering server tree on the configured interval', async () => {
    const jsx = await SteeringPage();
    render(jsx);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(24);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
