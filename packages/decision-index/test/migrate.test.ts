import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { decisions } from "../src/schema.js";
import * as schema from "../src/schema.js";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

describe("migrate (in-memory PGlite, decision_index schema)", () => {
  let t: PgliteTestDb;
  afterEach(async () => {
    await t?.cleanup();
  });

  const expectedTables = [
    "decisions",
    "decision_responses",
    "applied_transitions",
    "audit_log",
    "outbox",
    "worker_sessions",
    "protected_refs",
    "quarantine_events",
  ];

  async function pkColumns(table: string): Promise<string[]> {
    const res = await t.client.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'decision_index'
          AND tc.table_name = $1
        ORDER BY kcu.ordinal_position`,
      [table],
    );
    return res.rows.map((r) => r.column_name);
  }

  it("creates all tables in the decision_index schema", async () => {
    t = await makePgliteDb();
    const res = await t.client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'decision_index'",
    );
    const names = new Set(res.rows.map((r) => r.table_name));
    for (const tbl of expectedTables) {
      expect(names.has(tbl), `missing table ${tbl}`).toBe(true);
    }
  });

  it("decision_responses PK is decision_id (answered-once)", async () => {
    t = await makePgliteDb();
    expect(await pkColumns("decision_responses")).toEqual(["decision_id"]);
  });

  it("applied_transitions PK is (decision_id, transition_key)", async () => {
    t = await makePgliteDb();
    expect(await pkColumns("applied_transitions")).toEqual([
      "decision_id",
      "transition_key",
    ]);
  });

  it("outbox carries the CRITICAL 1 lease + owner columns (claimed_at, claimed_by)", async () => {
    t = await makePgliteDb();
    const res = await t.client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='decision_index' AND table_name='outbox'",
    );
    const names = new Set(res.rows.map((r) => r.column_name));
    expect(names.has("claimed_at")).toBe(true);
    expect(names.has("claimed_by")).toBe(true);
  });

  it("round-trips an insert/select through drizzle", async () => {
    t = await makePgliteDb();
    const now = new Date().toISOString();
    await t.db.insert(decisions).values({
      decision_id: "d1",
      protocol_version: "1",
      status: "open",
      source_url: "https://example.test/1",
      deployment: "dep",
      run_id: "r1",
      risk_class: "GREEN",
      question: "q",
      options_json: "[]",
      answer_schema_json: "{}",
      resume_mode: "mid_run",
      idempotency_key: "idem-1",
      created_at: now,
      updated_at: now,
    });
    const got = await t.db
      .select()
      .from(decisions)
      .where(eq(decisions.decision_id, "d1"));
    expect(got.length).toBe(1);
    // booleans default false (mapped from integer(boolean))
    expect(got[0]?.stale).toBe(false);
  });

  it("is idempotent across repeated startup", async () => {
    t = await makePgliteDb();
    // Re-running the migrator on the same db must be a no-op (tracked in
    // decision_index.__drizzle_migrations), not an error. Re-derive a pglite-typed
    // drizzle over the same client (t.db is typed as the production Db).
    await expect(
      pgliteMigrate(pgliteDrizzle(t.client, { schema }), {
        migrationsFolder,
        migrationsSchema: "decision_index",
      }),
    ).resolves.toBeUndefined();
  });
});
