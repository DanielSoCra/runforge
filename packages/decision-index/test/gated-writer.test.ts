import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { openDb, openReadOnlyDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createIndexWriter } from "../src/index-writer.js";
import { decisions, quarantineEvents } from "../src/schema.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";

// openDb / openReadOnlyDb / createIndexWriter all open postgres-js connections to
// a REAL Postgres (the read-only session + the writer connection cannot be modeled
// by the in-process PGlite backend). Gate this suite on a real Postgres URL; CI
// sets AUTO_CLAUDE_TEST_DATABASE_URL so it runs there.
const DB_URL = process.env.AUTO_CLAUDE_TEST_DATABASE_URL;

// Serialize the real-PG-gated files (they share the decision_index schema) so
// parallel CI forks never DROP/migrate each other's schema mid-test.
const SERIALIZE_LOCK = 982_451_653;

const NOW = "2026-05-27T08:00:00.000Z";

function rawRequest(id: string): unknown {
  return {
    decision_id: id,
    protocol_version: PROTOCOL_VERSION,
    source_url: "https://example.test/issues/1",
    source_etag: "etag-1",
    source_event_id: "evt-1",
    deployment: "dep",
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
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

describe.skipIf(!DB_URL)("gated single writer (A7/I7) [real Postgres]", () => {
  let protectedDir: string;
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
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-gated-"));
    // Reset the schema so each test sees a clean migrated decision_index.
    const { db, sql } = await openDb({ url: DB_URL! });
    await sql`DROP SCHEMA IF EXISTS decision_index CASCADE`;
    await migrate(db);
    await sql.end();
  });
  afterEach(() => {
    rmSync(protectedDir, { recursive: true, force: true });
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
    };
  }

  it("createIndexWriter constructs a working writer that admits + drives to notified", async () => {
    const writer = await createIndexWriter({ ...deps(), skipMigrate: true });
    const { decision_id } = await writer.admit(rawRequest("01HGATED00000000000000001"));
    await writer.runEffect(decision_id, "notify");
    expect((await writer.reader.get(decision_id))!.status).toBe("notified");
    await writer.close();
  });

  it("openReadOnlyDb rejects writes at the Postgres session level", async () => {
    const ro = openReadOnlyDb({ url: DB_URL! });
    let err: unknown;
    try {
      await ro.db.insert(quarantineEvents).values({ reason: "x", created_at: NOW });
    } catch (e) {
      err = e;
    }
    // drizzle wraps the postgres error; the "read-only transaction" text + 25006
    // (read_only_sql_transaction) code live on the cause chain.
    const chain = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
    expect(err, "read-only write must be rejected").toBeDefined();
    expect(chain).toMatch(/read-only|read only|25006/i);
    await ro.sql.end();
  });

  it("a read-only db can still read what the writer committed", async () => {
    const writer = await createIndexWriter({ ...deps(), skipMigrate: true });
    const { decision_id } = await writer.admit(rawRequest("01HGATED00000000000000002"));
    await writer.runEffect(decision_id, "notify");
    await writer.close();

    const ro = openReadOnlyDb({ url: DB_URL! });
    const rows = await ro.db
      .select({ status: decisions.status })
      .from(decisions)
      .where(eq(decisions.decision_id, "01HGATED00000000000000002"));
    expect(rows[0]!.status).toBe("notified");
    await ro.sql.end();
  });
});
