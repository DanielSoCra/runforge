import { describe, expect, it, vi } from 'vitest';

import type { AutoClaudeDb } from './client.js';
import {
  PostgresCostEventStore,
  PostgresRepoStore,
  PostgresRunStore,
} from './postgres-stores.js';

// Hand-rolled fake db chains (house pattern — see
// postgres-operator-auth-store.test.ts): unit tests over the Store seam,
// no Postgres, no port.

function errWithCode(message: string, code: string): Error {
  const e = new Error(message);
  (e as Error & { code?: string }).code = code;
  return e;
}

function createCostEventDb(options: {
  runExists?: boolean;
  windowRows?: Record<string, unknown>[];
}) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = options.windowRows ?? [];
          return {
            // runExists path: .where(...).limit(1)
            limit: vi.fn(async () =>
              options.runExists === true ? [{ id: 'run-1' }] : [],
            ),
            // listForWindow path: .where(...).orderBy(...)
            orderBy: vi.fn(async () => rows),
          };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: vi.fn(async () => [{ id: 'ce-1', ...values }]) };
      }),
    })),
  } as unknown as AutoClaudeDb;
  return { db, inserted };
}

describe('PostgresCostEventStore spend attribution', () => {
  it('persists provider and usageUnits when the caller attributes the event', async () => {
    const { db, inserted } = createCostEventDb({ runExists: true });

    const result = await new PostgresCostEventStore(db).recordCostEvent(
      'run-1',
      'implementation',
      1.5,
      { provider: 'claude-cli', usageUnits: 12_345 },
    );

    expect(result.ok).toBe(true);
    expect(inserted).toEqual([
      {
        runId: 'run-1',
        sessionType: 'implementation',
        cost: 1.5,
        provider: 'claude-cli',
        usageUnits: 12_345,
      },
    ]);
  });

  it('stores NULL attribution when the caller omits it (backward compatible)', async () => {
    const { db, inserted } = createCostEventDb({ runExists: true });

    const result = await new PostgresCostEventStore(db).recordCostEvent(
      'run-1',
      'planning',
      0.25,
    );

    expect(result.ok).toBe(true);
    expect(inserted).toEqual([
      {
        runId: 'run-1',
        sessionType: 'planning',
        cost: 0.25,
        provider: null,
        usageUnits: null,
      },
    ]);
  });

  it('stores NULL usageUnits when only the provider is known', async () => {
    const { db, inserted } = createCostEventDb({ runExists: true });

    await new PostgresCostEventStore(db).recordCostEvent(
      'run-1',
      'validation',
      0.1,
      { provider: 'codex' },
    );

    expect(inserted[0]).toMatchObject({ provider: 'codex', usageUnits: null });
  });

  it('still reports not-found for an unknown run', async () => {
    const { db, inserted } = createCostEventDb({ runExists: false });

    const result = await new PostgresCostEventStore(db).recordCostEvent(
      'missing-run',
      'fix',
      0.5,
      { provider: 'claude-cli' },
    );

    expect(result).toEqual({
      ok: false,
      error: 'not-found',
      message: 'run missing-run was not found',
    });
    expect(inserted).toHaveLength(0);
  });
});

describe('PostgresCostEventStore.listForWindow', () => {
  it('returns the window rows ordered by recording time', async () => {
    const rows = [
      { id: 'ce-1', provider: 'claude-cli', usageUnits: 100 },
      { id: 'ce-2', provider: null, usageUnits: null },
    ];
    const { db } = createCostEventDb({ windowRows: rows });

    const result = await new PostgresCostEventStore(db).listForWindow({
      from: new Date('2026-07-01T00:00:00Z'),
      to: new Date('2026-07-02T00:00:00Z'),
    });

    expect(result).toEqual({ ok: true, value: rows });
  });

  it('treats an empty window as success, not an error', async () => {
    const { db } = createCostEventDb({ windowRows: [] });

    const result = await new PostgresCostEventStore(db).listForWindow({
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-02T00:00:00Z'),
    });

    expect(result).toEqual({ ok: true, value: [] });
  });

  it('wraps driver failures as a categorized unavailable outcome', async () => {
    const db = {
      select: vi.fn(() => {
        throw errWithCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED');
      }),
    } as unknown as AutoClaudeDb;

    const result = await new PostgresCostEventStore(db).listForWindow({
      from: new Date(0),
      to: new Date(1),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'unavailable') {
      expect(result.category).toBe('unreachable');
      expect(result.cause.code).toBe('ECONNREFUSED');
    } else {
      expect.unreachable('expected an unavailable outcome');
    }
  });
});

describe('PostgresRunStore.attributionFor', () => {
  function createRunAttributionDb(rows: Record<string, unknown>[]) {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => rows),
        })),
      })),
    } as unknown as AutoClaudeDb;
    return db;
  }

  it('returns per-run project identity and completion time', async () => {
    const completedAt = new Date('2026-07-01T12:00:00Z');
    const db = createRunAttributionDb([
      { runId: 'run-1', projectId: 'repo-1', completedAt },
      { runId: 'run-2', projectId: null, completedAt: null },
    ]);

    const result = await new PostgresRunStore(db).attributionFor([
      'run-1',
      'run-2',
    ]);

    expect(result).toEqual({
      ok: true,
      value: [
        { runId: 'run-1', projectId: 'repo-1', completedAt },
        { runId: 'run-2', projectId: null, completedAt: null },
      ],
    });
  });

  it('short-circuits an empty id list without touching the database', async () => {
    const db = createRunAttributionDb([]);

    const result = await new PostgresRunStore(db).attributionFor([]);

    expect(result).toEqual({ ok: true, value: [] });
    expect(
      (db as unknown as { select: ReturnType<typeof vi.fn> }).select,
    ).not.toHaveBeenCalled();
  });
});

describe('PostgresRepoStore.namesFor', () => {
  function createRepoNamesDb(rows: Record<string, unknown>[]) {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => rows),
        })),
      })),
    } as unknown as AutoClaudeDb;
  }

  it('returns owner/name display identities for the requested projects', async () => {
    const db = createRepoNamesDb([
      { id: 'repo-1', owner: 'acme', name: 'widgets' },
    ]);

    const result = await new PostgresRepoStore(db).namesFor(['repo-1']);

    expect(result).toEqual({
      ok: true,
      value: [{ id: 'repo-1', name: 'acme/widgets' }],
    });
  });

  it('short-circuits an empty id list without touching the database', async () => {
    const db = createRepoNamesDb([]);

    const result = await new PostgresRepoStore(db).namesFor([]);

    expect(result).toEqual({ ok: true, value: [] });
    expect(
      (db as unknown as { select: ReturnType<typeof vi.fn> }).select,
    ).not.toHaveBeenCalled();
  });
});
