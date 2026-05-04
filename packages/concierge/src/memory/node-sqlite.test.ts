import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { applyConciergeStateSchemaMigrations, REQUIRED_STATE_TABLES } from './state-schema.js';
import { openConciergeStateDatabase } from './node-sqlite.js';

describe('node sqlite concierge state database', () => {
  it('persists applied migrations and exposes required state tables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concierge-state-'));
    const dbPath = join(dir, 'state.db');
    const db = openConciergeStateDatabase(dbPath);

    await applyConciergeStateSchemaMigrations(db, db);
    await applyConciergeStateSchemaMigrations(db, db);

    expect(db.appliedMigrationIds()).toEqual(['001-concierge-state-schema']);
    expect(db.tableNames()).toEqual(expect.arrayContaining([...REQUIRED_STATE_TABLES]));
    db.close();

    const reopened = openConciergeStateDatabase(dbPath);
    expect(reopened.appliedMigrationIds()).toEqual(['001-concierge-state-schema']);
    reopened.close();
  });
});
