import { describe, expect, it } from 'vitest';
import type { ConciergeEventRecord, ConciergeEventStore } from '../memory/state-stores.js';
import { createDaemonStatusPoller } from './daemon-poll.js';

describe('daemon status poller', () => {
  it('emits metadata-only daemon status events and deduplicates unchanged snapshots', async () => {
    const events = inMemoryEvents(() => 1_000);
    const poller = createDaemonStatusPoller({
      events,
      client: {
        status: async () => ({
          paused: true,
          activeRuns: 0,
          activeIssues: [],
          dailyCost: 0,
        }),
      },
    });

    await expect(poller.pollOnce()).resolves.toBe(true);
    await expect(poller.pollOnce()).resolves.toBe(false);

    expect(events.list()).toEqual([
      {
        id: 1,
        source: 'observer',
        type: 'daemon_paused',
        status: 'new',
        createdAt: 1_000,
        payload: {
          paused: true,
          activeRuns: 0,
          activeIssues: [],
          dailyCost: 0,
        },
      },
    ]);
  });

  it('emits daemon_unreachable when status fetch fails', async () => {
    const events = inMemoryEvents(() => 2_000);
    const poller = createDaemonStatusPoller({
      events,
      client: {
        status: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });

    await expect(poller.pollOnce()).resolves.toBe(true);

    expect(events.list()).toEqual([
      expect.objectContaining({
        type: 'daemon_unreachable',
        payload: { error: 'ECONNREFUSED' },
        createdAt: 2_000,
      }),
    ]);
  });
});

function inMemoryEvents(now: () => number): ConciergeEventStore {
  const records: ConciergeEventRecord[] = [];
  return {
    append(input) {
      const record = {
        id: records.length + 1,
        createdAt: now(),
        ...input,
      };
      records.push(record);
      return record;
    },
    list() {
      return [...records];
    },
  };
}
