import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/** The single durable-write handle type (spec §3.1). Writer + reader both use it. */
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

/**
 * The advisory-lock name; `hashtext(WRITER_LOCK_NAME)` => K (an int4 lock key),
 * computed once per db and reused for the boot fast-fail + every per-tx guard.
 * Cross-process processes running this same code all compute the same K against
 * the same Postgres, so single-writer is enforced cross-process (spec §3.4).
 */
const WRITER_LOCK_NAME = "runforge:decision-index:writer";

/**
 * Minimal FIFO async mutex (no new dependency). Serializes the writer's own
 * transactions so better-sqlite3's "one synchronous connection == no
 * interleaving" semantics are preserved on async Postgres (spec §3.5).
 */
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

/** Per-writer guard state, keyed by the drizzle db object (WeakMap, GC-safe). */
interface WriterGuard {
  mutex: Mutex;
  /** hashtext(WRITER_LOCK_NAME) — lazily computed on the first write tx. */
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

/**
 * Re-entrant "current writer transaction" context (spec §3.5). When a write is
 * already inside the writer tx (e.g. outbox.commit -> apply -> withTx), the inner
 * withTx REUSES the open tx (flatten onto the same transaction) rather than
 * blocking on the mutex — which would deadlock — or opening a savepoint.
 */
const writerTxCtx = new AsyncLocalStorage<{ tx: Db }>();

/**
 * postgres-js `db.execute(sql)` returns the row array directly; the PGlite driver
 * returns `{ rows }`. Normalize so the advisory-lock / hashtext probes work on
 * both the production (postgres-js) and the test (PGlite) backend.
 */
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

/**
 * Open the single WRITER connection (spec §3.1). `max:1` + disabled recycling
 * keeps a stable, non-rotating backend so the serial-writer discipline is simple
 * and reconnects are rare (correctness does NOT depend on this — the per-tx
 * advisory xact-lock re-asserts single-writer on every write regardless).
 *
 * Runs the boot fast-fail (spec §3.4 layer 1, NON-holding): acquire
 * `pg_try_advisory_lock(K)` then IMMEDIATELY release it. A `false` result means
 * another writer is mid-write right now — a cheap "two daemons, one DB" alarm.
 * It does NOT hold the lock for the connection lifetime (holding a session lock
 * is reconnect-unsafe and would make the cross-process test un-runnable).
 */
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
        "decision-index: another writer holds the store (boot fast-fail)",
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

/**
 * Open a READ-ONLY connection pool (I7 / spec §3.1). Sessions are forced
 * read-only at the Postgres level (`default_transaction_read_only=on`), so a
 * stray write physically rejects — reproducing sqlite's `{readonly:true}`
 * guarantee. Non-writer callers (CLI list/view, dashboard, reconcile-readers)
 * open this.
 */
export function openReadOnlyDb(opts: OpenDbOptions): ReadOnlyHandle {
  const client = postgres(opts.url, {
    // forces every session read-only at the Postgres level (GUC accepts true/on).
    connection: { default_transaction_read_only: true },
  });
  const db = drizzle(client, { schema }) as Db;
  return { db, sql: client };
}

/**
 * Run `fn` inside the single durable-write primitive (spec §3.5 + §3.4 layer 2).
 *
 *  - Re-entrant: if already inside the writer tx, REUSE it (flatten) — no mutex,
 *    no new transaction, no savepoint. This prevents the commit->apply nested
 *    `withTx` deadlock.
 *  - Otherwise acquire the process-local FIFO writer mutex, open ONE Postgres
 *    transaction, and as its FIRST statement take `pg_try_advisory_xact_lock(K)`
 *    AND check the boolean — `false` => another writer holds the store => throw
 *    (abort + surface). The xact-lock auto-releases at tx end and is immune to
 *    reconnects (the sole authoritative cross-process single-writer guarantee).
 */
export async function withTx<T>(
  db: Db,
  fn: (tx: Db) => Promise<T> | T,
): Promise<T> {
  const current = writerTxCtx.getStore();
  if (current) {
    // Already inside the writer tx — reuse it (flatten onto the same txn).
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
          "decision-index: another writer holds the store (per-tx advisory lock)",
        );
      }
      return writerTxCtx.run({ tx }, () => fn(tx));
    }),
  ) as Promise<T>;
}

export { schema };
