import { describe, expect, it, vi } from 'vitest';
import type {
  ConciergeCardRecord,
  ConciergeCardStore,
  ConciergeEventRecord,
  ConciergeEventStore,
} from '../memory/state-stores.js';
import { classifyConciergeEvent, createEventCardMaterializer } from './classifier.js';

describe('concierge event classifier', () => {
  it('maps operator-relevant daemon events to board cards and keeps manual activity silent', () => {
    expect(classifyConciergeEvent(event({
      id: 1,
      type: 'daemon_stuck',
      payload: {
        activeIssues: [504],
        consecutiveStuckCount: 2,
      },
    }))).toEqual({
      outcomes: ['surface_card', 'slack_dm'],
      card: {
        status: 'needs_decision',
        title: 'Daemon stuck',
        body: 'consecutiveStuckCount: 2; activeIssues: 504',
      },
    });

    expect(classifyConciergeEvent(event({
      id: 2,
      type: 'manual_commit',
      payload: {
        repoPath: '/repo',
        branch: 'dev',
        commit: 'abc123',
      },
    }))).toEqual({ outcomes: ['silent_log'] });

    expect(classifyConciergeEvent(event({ id: 3, type: 'unknown_event' })))
      .toEqual({ outcomes: ['silent_log'] });
  });

  it('materializes surface-card classifications into deterministic board cards once', () => {
    const events = inMemoryEvents([
      event({
        id: 1,
        type: 'daemon_stuck',
        payload: {
          activeIssues: [504],
          consecutiveStuckCount: 2,
        },
      }),
      event({
        id: 2,
        type: 'manual_branch_created',
        payload: {
          repoPath: '/repo',
          branch: 'feature/504',
          commit: 'abc123',
        },
      }),
    ]);
    const cards = inMemoryCards();
    const materializer = createEventCardMaterializer({ events, cards });

    expect(materializer.processOnce()).toBe(1);
    expect(materializer.processOnce()).toBe(0);
    expect(cards.list()).toEqual([
      {
        id: 'event-1',
        status: 'needs_decision',
        title: 'Daemon stuck',
        body: 'consecutiveStuckCount: 2; activeIssues: 504',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
  });
});

function event(input: {
  id: number;
  type: string;
  payload?: unknown;
}): ConciergeEventRecord {
  return {
    id: input.id,
    source: 'observer',
    type: input.type,
    status: 'new',
    payload: input.payload ?? {},
    createdAt: input.id * 1_000,
  };
}

function inMemoryEvents(records: ConciergeEventRecord[]): ConciergeEventStore {
  return {
    append: vi.fn(),
    list: () => [...records],
  };
}

function inMemoryCards(): ConciergeCardStore {
  const records = new Map<string, ConciergeCardRecord>();
  return {
    upsert(input) {
      const record = {
        ...input,
        createdAt: 1_000,
        updatedAt: 1_000,
      };
      records.set(record.id, record);
      return record;
    },
    updateStatus: vi.fn(),
    get: (id) => records.get(id),
    list: () => [...records.values()],
  };
}
