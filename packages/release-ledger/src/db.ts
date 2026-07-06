import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/** The single durable-write handle type. Writer + reader both use it. */
export type Db = PostgresJsDatabase<typeof schema>;

/** Raw postgres-js client type (held so the writer can `end()` it on close). */
export type Sql = ReturnType<typeof postgres>;

export interface OpenDbOptions {
  /** Postgres connection URL (RUNFORGE_DATABASE_URL). */
  url: string;
}

export interface WriterHandle {
  db: Db;
  /** raw client — call `sql.end()` to release the writer connection on close. */
  sql: Sql;
}

export interface ReadOnlyHandle {
  db: Db;
  sql: Sql;
}

const WRITER_LOCK_NAME = "runforge:release-ledger:writer";

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface WriterGuard {
  mutex: Mutex;
  key: number | undefined;
}
const guards = new WeakMap<object, WriterGuard>();

function guardFor(db: object): WriterGuard {
  let g = guards.get(db);
  if (!g) {
    g = { mutex: new Mutex(), key: undefined };
    guards.set(db, g);
  }
  return g;
}

const writerTxCtx = new AsyncLocalStorage<{ tx: Db }>();

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const r = (res as { rows?: unknown[] } | null)?.rows;
  return (r ?? []) as Array<Record<string, unknown>>;
}

async function ensureKey(guard: WriterGuard, exec: Db): Promise<number> {
  if (guard.key !== undefined) return guard.key;
  const rows = rowsOf(
    await exec.execute(sql`SELECT hashtext(${WRITER_LOCK_NAME}) AS k`),
  );
  guard.key = Number((rows[0] as { k: number | string }).k);
  return guard.key;
}

async function acquireXactLock(exec: Db, key: number): Promise<boolean> {
  const rows = rowsOf(
    await exec.execute(sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`),
  );
  return Boolean((rows[0] as { locked: boolean }).locked);
}

export async function openDb(opts: OpenDbOptions): Promise<WriterHandle> {
  const client = postgres(opts.url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
  });
  const db = drizzle(client, { schema }) as Db;
  try {
    const keyRows = await client`SELECT hashtext(${WRITER_LOCK_NAME}) AS k`;
    const key = Number((keyRows[0] as { k: number }).k);
    const lockRows = await client`SELECT pg_try_advisory_lock(${key}) AS locked`;
    if (!(lockRows[0] as { locked: boolean }).locked) {
      throw new Error(
        "release-ledger: another writer holds the store (boot fast-fail)",
      );
    }
    await client`SELECT pg_advisory_unlock(${key})`;
    guards.set(db, { mutex: new Mutex(), key });
  } catch (err) {
    await client.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
  return { db, sql: client };
}

export function openReadOnlyDb(opts: OpenDbOptions): ReadOnlyHandle {
  const client = postgres(opts.url, {
    connection: { default_transaction_read_only: true },
  });
  const db = drizzle(client, { schema }) as Db;
  return { db, sql: client };
}

export async function withTx<T>(
  db: Db,
  fn: (tx: Db) => Promise<T> | T,
): Promise<T> {
  const current = writerTxCtx.getStore();
  if (current) {
    return await fn(current.tx);
  }
  const guard = guardFor(db);
  return guard.mutex.runExclusive(() =>
    db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const key = await ensureKey(guard, tx);
      const locked = await acquireXactLock(tx, key);
      if (!locked) {
        throw new Error(
          "release-ledger: another writer holds the store (per-tx advisory lock)",
        );
      }
      return writerTxCtx.run({ tx }, () => fn(tx));
    }),
  ) as Promise<T>;
}

export { schema };
