import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";
import { openDb, openReadOnlyDb } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";
import { createIndexWriter, type IndexWriter } from "../../src/index-writer.js";
import { quarantineEvents } from "../../src/schema.js";
import { TEST_PROTECTED_KEY } from "../helpers/temp-db.js";
import { FakeNotifier } from "../../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../../src/adapters/fakes/fake-resume-dispatcher.js";

/**
 * REQUIRED real-Postgres integration suite (spec §5). PGlite is a single in-process
 * backend and CANNOT prove the cross-process / multi-session single-writer
 * guarantee, so this exercises it against a real Postgres:
 *   (1) construct the writer while K is free, THEN a SECOND session holds
 *       pg_advisory_lock(K) — every public mutator must throw (the per-tx
 *       xact-lock proof, §3.5a — runnable precisely because the boot check is
 *       NON-holding);
 *   (2) the boot fast-fail throws when a second session already holds K at
 *       construction time;
 *   (3) a read-only session rejects writes.
 *
 * Gated on AUTO_CLAUDE_TEST_DATABASE_URL (CI sets it; local skips). The suite
 * mutates the shared `decision_index` schema, so it holds a SESSION-level
 * serialize advisory lock for its whole run — under parallel CI forks the other
 * real-PG-gated files (gated-writer, handle-leak) take the same lock and serialize.
 */
const DB_URL = process.env.AUTO_CLAUDE_TEST_DATABASE_URL;

// K = hashtext('auto-claude:decision-index:writer') — the writer lock the source
// computes. A separate large constant serializes the real-PG-gated test FILES.
const SERIALIZE_LOCK = 982_451_653;

const NOW = "2026-05-27T09:00:00.000Z";

function rawRequest(id: string): unknown {
  return {
    decision_id: id,
    protocol_version: PROTOCOL_VERSION,
    source_url: "https://example.test/issues/1",
    source_etag: "etag-1",
    source_event_id: "evt-1",
    deployment: "dep",
    run_id: "run-1",
    risk_class: "P1",
    question: "Proceed?",
    context: "ctx",
    options: [{ id: "yes", label: "Yes" }],
    recommended_option: "yes",
    consequence_of_no_answer: "paused",
    reversibility: "reversible",
    expires_at: "2026-06-01T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: "mid_run",
    idempotency_key: "idem-1",
  };
}

describe.skipIf(!DB_URL)("cross-process single-writer [real Postgres]", () => {
  let serializer: ReturnType<typeof postgres>;
  let writerKey: number;
  let protectedDir: string;

  beforeAll(async () => {
    // Serialize across the real-PG-gated test files (shared decision_index schema).
    serializer = postgres(DB_URL!, { max: 1 });
    await serializer`SELECT pg_advisory_lock(${SERIALIZE_LOCK})`;
    const [{ k }] = await serializer<{ k: number }[]>`
      SELECT hashtext('auto-claude:decision-index:writer') AS k`;
    writerKey = Number(k);
  });

  afterAll(async () => {
    await serializer`SELECT pg_advisory_unlock(${SERIALIZE_LOCK})`;
    await serializer.end();
  });

  beforeEach(async () => {
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-xproc-"));
    const { db, sql } = await openDb({ url: DB_URL! });
    await sql`DROP SCHEMA IF EXISTS decision_index CASCADE`;
    await migrate(db);
    await sql.end();
  });

  function deps() {
    return {
      databaseUrl: DB_URL!,
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir,
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date(NOW),
      channel: "slack",
      skipMigrate: true,
    };
  }

  it("(1) when a SECOND session holds K, every public mutator throws (per-tx xact-lock)", async () => {
    const writer: IndexWriter = await createIndexWriter(deps());
    // A second session takes and HOLDS the writer advisory lock.
    const holder = postgres(DB_URL!, { max: 1 });
    await holder`SELECT pg_advisory_lock(${writerKey})`;
    try {
      // admit goes through withTx -> pg_try_advisory_xact_lock fails -> throws.
      await expect(writer.admit(rawRequest("01HXPROC0000000000000001"))).rejects.toThrow(
        /another writer holds the store/i,
      );
      // a guarded quarantine write also throws.
      await expect(writer.quarantine.record({ reason: "x" })).rejects.toThrow(
        /another writer holds the store/i,
      );
    } finally {
      await holder`SELECT pg_advisory_unlock(${writerKey})`;
      await holder.end();
      await writer.close();
    }
  });

  it("(2) boot fast-fail throws when a second session already holds K at construction", async () => {
    const holder = postgres(DB_URL!, { max: 1 });
    await holder`SELECT pg_advisory_lock(${writerKey})`;
    try {
      await expect(createIndexWriter(deps())).rejects.toThrow(/boot fast-fail|another writer/i);
    } finally {
      await holder`SELECT pg_advisory_unlock(${writerKey})`;
      await holder.end();
    }
  });

  it("(3) a read-only session rejects writes", async () => {
    const ro = openReadOnlyDb({ url: DB_URL! });
    let err: unknown;
    try {
      await ro.db.insert(quarantineEvents).values({ reason: "x", created_at: NOW });
    } catch (e) {
      err = e;
    }
    // drizzle wraps the postgres error; the "read-only transaction" text + the
    // 25006 (read_only_sql_transaction) code live on the cause chain.
    const chain = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
    expect(err, "read-only write must be rejected").toBeDefined();
    expect(chain).toMatch(/read-only|read only|25006/i);
    await ro.sql.end();
  });
});
