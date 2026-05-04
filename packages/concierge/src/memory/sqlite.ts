export interface Migration {
  id: string;
  up: () => Promise<void>;
}

export interface MigrationStore {
  hasMigration(id: string): boolean;
  recordMigration(id: string): void;
  appliedMigrationIds(): string[];
}

export function createInMemoryMigrationStore(initialIds: string[] = []): MigrationStore {
  const applied = new Set(initialIds);
  return {
    hasMigration(id: string): boolean {
      return applied.has(id);
    },

    recordMigration(id: string): void {
      applied.add(id);
    },

    appliedMigrationIds(): string[] {
      return [...applied.values()];
    },
  };
}

export async function runForwardOnlyMigrations(
  store: MigrationStore,
  migrations: Migration[],
): Promise<void> {
  assertUniqueMigrationIds(migrations);
  for (const migration of migrations) {
    if (store.hasMigration(migration.id)) continue;
    await migration.up();
    store.recordMigration(migration.id);
  }
}

function assertUniqueMigrationIds(migrations: Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id ${migration.id}`);
    }
    seen.add(migration.id);
  }
}
