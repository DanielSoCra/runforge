import { describe, expect, it } from 'vitest';
import { createInMemoryMigrationStore, runForwardOnlyMigrations, type Migration } from './sqlite.js';

describe('sqlite migration boundary', () => {
  it('applies pending migrations in order and records them once', async () => {
    const store = createInMemoryMigrationStore();
    const applied: string[] = [];
    const migrations: Migration[] = [
      { id: '001_init', up: async () => { applied.push('001_init'); } },
      { id: '002_audit', up: async () => { applied.push('002_audit'); } },
    ];

    await runForwardOnlyMigrations(store, migrations);
    await runForwardOnlyMigrations(store, migrations);

    expect(applied).toEqual(['001_init', '002_audit']);
    expect(store.appliedMigrationIds()).toEqual(['001_init', '002_audit']);
  });

  it('rejects duplicate migration ids', async () => {
    const store = createInMemoryMigrationStore();

    await expect(runForwardOnlyMigrations(store, [
      { id: '001_init', up: async () => undefined },
      { id: '001_init', up: async () => undefined },
    ])).rejects.toThrow(/duplicate migration id 001_init/);
  });
});
