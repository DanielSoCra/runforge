import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createIndexWriter, type IndexWriter } from "../src/index-writer.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";

/**
 * HANDLE-LEAK FIX (verdict fix_before_flag_on / index-writer.ts:84): on Postgres,
 * createIndexWriter opens the writer connection via openDb(), then runs migrate()
 * and constructs ProtectedStoreImpl. If EITHER throws after openDb() succeeded, the
 * postgres-js connection (`sql`) would leak unless the factory ends it before
 * rethrowing. A bad-length protectedKey makes the ProtectedStore ctor throw, which
 * exercises exactly that window.
 *
 * Opening a real postgres-js connection requires a real Postgres, so this is gated
 * on RUNFORGE_TEST_DATABASE_URL (set in CI). The leak guard is the factory's
 * `catch { await sql.end() }`; here we assert the throw surfaces AND a subsequent
 * healthy writer still constructs + closes (the broken path freed its connection
 * rather than wedging the writer).
 */
const DB_URL = process.env.RUNFORGE_TEST_DATABASE_URL;

// Serialize the real-PG-gated files (shared decision_index schema) across forks.
const SERIALIZE_LOCK = 982_451_653;

describe.skipIf(!DB_URL)("createIndexWriter frees the writer connection when construction throws [real Postgres]", () => {
  let dir: string;
  let serializer: ReturnType<typeof postgres>;

  beforeAll(async () => {
    serializer = postgres(DB_URL!, { max: 1 });
    await serializer`SELECT pg_advisory_lock(${SERIALIZE_LOCK})`;
  });
  afterAll(async () => {
    await serializer`SELECT pg_advisory_unlock(${SERIALIZE_LOCK})`;
    await serializer.end();
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pm-leak-"));
    const { db, sql } = await openDb({ url: DB_URL! });
    await sql`DROP SCHEMA IF EXISTS decision_index CASCADE`;
    await migrate(db);
    await sql.end();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseDeps() {
    return {
      databaseUrl: DB_URL!,
      protectedDir: join(dir, "protected"),
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date("2026-05-27T00:00:00.000Z"),
      skipMigrate: true,
    };
  }

  it("a bad protectedKey (ProtectedStore ctor throws) surfaces and does not leak the connection", async () => {
    // A non-32-byte base64 key forces the ProtectedStore ctor to throw AFTER
    // openDb() succeeded — the factory's catch must end the connection.
    await expect(
      createIndexWriter({ ...baseDeps(), protectedKey: Buffer.from("short").toString("base64") }),
    ).rejects.toThrow(/32 bytes/);
  });

  it("a healthy construction returns a usable writer that closes cleanly (regression)", async () => {
    const validKey = Buffer.alloc(32, 9).toString("base64");
    const writer: IndexWriter = await createIndexWriter({ ...baseDeps(), protectedKey: validKey });
    expect(writer.reader).toBeDefined();
    await writer.close();
  });
});
