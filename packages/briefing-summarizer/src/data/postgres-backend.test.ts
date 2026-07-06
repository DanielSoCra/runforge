import { describe, expect, it, vi } from 'vitest';

import { createPostgresBriefingBackendFromStores } from './postgres-backend.js';

function createBackend(overrides?: {
  readLatestBriefing?: ReturnType<typeof vi.fn>;
  listRunsForSignals?: ReturnType<typeof vi.fn>;
}) {
  const briefings = {
    readLatestBriefing:
      overrides?.readLatestBriefing ??
      vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'not-found', message: 'none' }),
    listRunsForSignals:
      overrides?.listRunsForSignals ??
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
    appendBriefing: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    appendActivityEvents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    countNotificationChannels: vi
      .fn()
      .mockResolvedValue({ ok: true, value: 0 }),
  };

  return {
    backend: createPostgresBriefingBackendFromStores({ briefings } as never),
    briefings,
  };
}

describe('Postgres briefing backend', () => {
  it('returns null when there is no previous briefing', async () => {
    const { backend } = createBackend();

    await expect(backend.getPreviousBriefing()).resolves.toBeNull();
  });

  it('maps Run rows to the existing signal snapshot shape', async () => {
    const listRunsForSignals = vi.fn().mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'run-1',
          repoId: 'repo-1',
          repoOwner: 'DANIELSOCRAHANDLEZZ',
          repoName: 'runforge',
          issueNumber: 626,
          issueTitle: 'Migrate data platform',
          pipelineVariant: 'standard',
          currentPhase: 'implementation',
          outcome: 'in-progress',
          totalCost: 1.25,
          phases: [],
          fixAttempts: 0,
          report: null,
          activePlugins: ['plugin-a'],
          startedAt: new Date('2026-05-20T10:00:00Z'),
          completedAt: null,
          updatedAt: new Date('2026-05-20T11:00:00Z'),
        },
      ],
    });
    const { backend } = createBackend({ listRunsForSignals });

    const rows = await backend.listRunsSince('2026-05-20T00:00:00Z');

    expect(listRunsForSignals).toHaveBeenCalledWith(
      new Date('2026-05-20T00:00:00Z'),
    );
    expect(rows[0]).toMatchObject({
      id: 'run-1',
      repo_id: 'repo-1',
      issue_number: 626,
      current_phase: 'implementation',
      phase: 'implementation',
      updated_at: '2026-05-20T11:00:00.000Z',
    });
  });

  it('surfaces StoreResult errors as backend failures', async () => {
    const { backend } = createBackend({
      listRunsForSignals: vi.fn().mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'database down',
      }),
    });

    await expect(backend.listRunsSince('2026-05-20T00:00:00Z')).rejects.toThrow(
      /database down/,
    );
  });
});
