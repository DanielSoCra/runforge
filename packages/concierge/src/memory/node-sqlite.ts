import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationStore } from './sqlite.js';
import type { SqlExecutor } from './state-schema.js';

export interface ConciergeStateDatabase extends MigrationStore, SqlExecutor {
  close(): void;
  tableNames(): string[];
}

export function defaultConciergeStateDbPath(): string {
  return join(homedir(), 'Library/Application Support/concierge/state.db');
}

export function openConciergeStateDatabase(path = defaultConciergeStateDbPath()): ConciergeStateDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);

  return {
    exec(sql): void {
      database.exec(sql);
    },

    hasMigration(id): boolean {
      try {
        const row = database
          .prepare('SELECT id FROM schema_migrations WHERE id = ?')
          .get(id) as { id?: string } | undefined;
        return row?.id === id;
      } catch (error) {
        if (isMissingTable(error)) return false;
        throw error;
      }
    },

    recordMigration(id): void {
      database
        .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(id, Date.now());
    },

    appliedMigrationIds(): string[] {
      try {
        const rows = database
          .prepare('SELECT id FROM schema_migrations ORDER BY id')
          .all() as Array<{ id: string }>;
        return rows.map((row) => row.id);
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    tableNames(): string[] {
      const rows = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    },

    close(): void {
      database.close();
    },
  };
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: schema_migrations/i.test(error.message);
}
