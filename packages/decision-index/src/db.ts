import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

export interface OpenDbOptions {
  path: string;
}

/**
 * Open a single better-sqlite3 connection in WAL mode with FKs on.
 * One connection == single writer (spec Q2). Readers use WAL concurrency.
 */
export function openDb(opts: OpenDbOptions): Db {
  const sqlite = new Database(opts.path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema }) as Db;
  // expose raw client for migration + pragma probes
  (db as unknown as { $client: Database.Database }).$client = sqlite;
  return db;
}

/**
 * Open a READ-ONLY connection (I7). Non-writer callers (CLI list/view, dashboard,
 * reconcile-readers) open this — it physically rejects any write at the SQLite
 * layer, so the single-writer invariant cannot be violated by a stray reader.
 */
export function openReadOnlyDb(opts: OpenDbOptions): Db {
  const sqlite = new Database(opts.path, { readonly: true });
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema }) as Db;
  (db as unknown as { $client: Database.Database }).$client = sqlite;
  return db;
}

/**
 * Run `fn` inside a single SQLite transaction (the only durable-write primitive).
 * better-sqlite3 transactions are synchronous; `fn` must be synchronous too.
 */
export function withTx<T>(db: Db, fn: (tx: Db) => T): T {
  const client = db.$client;
  const txFn = client.transaction(() => fn(db));
  return txFn();
}

export { schema };
