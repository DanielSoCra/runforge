import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationStore } from './sqlite.js';
import type { SqlExecutor } from './state-schema.js';

export type SqlParameter = string | number | bigint | Buffer | Uint8Array | null;
export type SqlRow = object;

export interface ConciergeStateDatabase extends MigrationStore, SqlExecutor {
  run(sql: string, ...params: SqlParameter[]): void;
  get<Row extends SqlRow>(sql: string, ...params: SqlParameter[]): Row | undefined;
  all<Row extends SqlRow>(sql: string, ...params: SqlParameter[]): Row[];
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

    run(sql, ...params): void {
      database.prepare(sql).run(...params);
    },

    get(sql, ...params) {
      return database.prepare(sql).get(...params) as never;
    },

    all(sql, ...params) {
      return database.prepare(sql).all(...params) as never;
    },

    hasMigration(id): boolean {
      try {
        const row = this.get<{ id?: string }>('SELECT id FROM schema_migrations WHERE id = ?', id);
        return row?.id === id;
      } catch (error) {
        if (isMissingTable(error)) return false;
        throw error;
      }
    },

    recordMigration(id): void {
      this.run('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)', id, Date.now());
    },

    appliedMigrationIds(): string[] {
      try {
        const rows = this.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
        return rows.map((row) => row.id);
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    tableNames(): string[] {
      const rows = this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
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
