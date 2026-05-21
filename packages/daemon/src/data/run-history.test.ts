import { describe, expect, it, vi } from 'vitest';

import { PostgresRunHistory } from './run-history.js';

describe('PostgresRunHistory', () => {
  it('counts stuck runs through RunStore', async () => {
    const runs = {
      countStuckRunsForIssue: vi.fn().mockResolvedValue({ ok: true, value: 2 }),
    };
    const history = new PostgresRunHistory(runs as never);

    await expect(
      history.countStuckRunsForIssue({
        repoOwner: 'org',
        repoName: 'repo',
        issueNumber: 42,
      }),
    ).resolves.toBe(2);
  });

  it('marks in-progress runs stuck through RunStore', async () => {
    const runs = {
      markInProgressRunsStuck: vi
        .fn()
        .mockResolvedValue({ ok: true, value: ['run-1', 'run-2'] }),
    };
    const history = new PostgresRunHistory(runs as never);

    await expect(history.markInProgressRunsStuck()).resolves.toBe(2);
    expect(runs.markInProgressRunsStuck).toHaveBeenCalledWith(expect.any(Date));
  });

  it('returns null and logs when the Store is unavailable', async () => {
    const runs = {
      countStuckRunsForIssue: vi.fn().mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'db down',
      }),
    };
    const history = new PostgresRunHistory(runs as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      history.countStuckRunsForIssue({
        repoOwner: 'org',
        repoName: 'repo',
        issueNumber: 42,
      }),
    ).resolves.toBeNull();

    warn.mockRestore();
  });
});
