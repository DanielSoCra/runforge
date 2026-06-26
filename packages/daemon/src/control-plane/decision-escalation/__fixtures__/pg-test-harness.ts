/**
 * Shared real-Postgres test harness for the daemon's writer-backed
 * decision-index suites.
 *
 * The decision-index Postgres migration made `createIndexWriter` /
 * `DecisionIndexManager.init()` open a REAL postgres-js writer connection (the
 * single-writer + read-only-session guarantees cannot be modelled by an
 * in-process backend). Every daemon test that builds a real writer therefore:
 *
 *   1. is GATED on a real Postgres URL (`AUTO_CLAUDE_TEST_DATABASE_URL`, set by
 *      CI; locally the suite skips), and
 *   2. holds ONE shared session-level advisory lock for the whole file so that,
 *      under parallel CI vitest forks, no two writer-backed files DROP/migrate
 *      each other's shared `decision_index` schema mid-test.
 *
 * `SERIALIZE_LOCK` is the SAME constant the decision-index package's real-PG
 * files (`gated-writer`, `index-writer-handle-leak`, the cross-process suite)
 * take, so the daemon and decision-index Postgres suites all serialize against
 * one another too.
 */
import postgres from 'postgres';

/** Real Postgres URL the gated suites connect to; undefined → skip the suite. */
export const DECISION_DB_URL = process.env.AUTO_CLAUDE_TEST_DATABASE_URL;

/** True when a real Postgres is configured (drives `describe.skipIf(!REAL_PG)`). */
export const REAL_PG = Boolean(DECISION_DB_URL);

// Large fixed constant shared with the decision-index real-PG-gated files. All
// writer-backed Postgres suites take THIS session advisory lock, so parallel
// forks serialize on the shared `decision_index` schema.
const SERIALIZE_LOCK = 982_451_653;

/**
 * A dedicated serializer connection that (a) holds the cross-file session
 * advisory lock and (b) resets the `decision_index` schema between tests.
 * `createIndexWriter` runs its own `migrate()` on construction (the daemon path
 * never passes `skipMigrate`), so `resetSchema()` only needs to DROP — the next
 * writer build re-creates the schema.
 */
export interface SchemaSerializer {
  /** Acquire the shared session advisory lock (call once in `beforeAll`). */
  lock(): Promise<void>;
  /** Release the lock + close the connection (call once in `afterAll`). */
  release(): Promise<void>;
  /** DROP the shared schema so the next writer build starts clean (`beforeEach`). */
  resetSchema(): Promise<void>;
}

/**
 * Open a serializer connection. MUST be called from a real-PG-gated context
 * (REAL_PG === true); `DECISION_DB_URL` is asserted non-null.
 */
export function makeSchemaSerializer(): SchemaSerializer {
  const sql = postgres(DECISION_DB_URL!, { max: 1 });
  return {
    async lock() {
      await sql`SELECT pg_advisory_lock(${SERIALIZE_LOCK})`;
    },
    async release() {
      await sql`SELECT pg_advisory_unlock(${SERIALIZE_LOCK})`;
      await sql.end();
    },
    async resetSchema() {
      await sql`DROP SCHEMA IF EXISTS decision_index CASCADE`;
    },
  };
}
