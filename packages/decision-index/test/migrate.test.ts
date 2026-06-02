import { describe, it, expect, afterEach } from "vitest";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { migrate } from "../src/migrate.js";

describe("migrate (on-disk temp SQLite)", () => {
  let t: TempDb;
  afterEach(() => t?.cleanup());

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

  it("creates all tables", () => {
    t = makeTempDb();
    const rows = t.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const tbl of expectedTables) {
      expect(names.has(tbl), `missing table ${tbl}`).toBe(true);
    }
  });

  it("enables WAL journal mode", () => {
    t = makeTempDb();
    const mode = t.db.$client.pragma("journal_mode", { simple: true });
    expect(String(mode).toLowerCase()).toBe("wal");
  });

  it("decision_responses PK is decision_id (answered-once)", () => {
    t = makeTempDb();
    const pk = t.db.$client
      .prepare("PRAGMA table_info('decision_responses')")
      .all() as { name: string; pk: number }[];
    const pkCols = pk.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toEqual(["decision_id"]);
  });

  it("applied_transitions PK is (decision_id, transition_key)", () => {
    t = makeTempDb();
    const pk = t.db.$client
      .prepare("PRAGMA table_info('applied_transitions')")
      .all() as { name: string; pk: number }[];
    const pkCols = pk
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(["decision_id", "transition_key"]);
  });

  it("outbox carries the CRITICAL 1 claim-lease column (claimed_at)", () => {
    t = makeTempDb();
    const cols = t.db.$client
      .prepare("PRAGMA table_info('outbox')")
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("claimed_at")).toBe(true);
  });

  it("outbox carries the CRITICAL 1 owner-token column (claimed_by, migration 0005)", () => {
    t = makeTempDb();
    const cols = t.db.$client
      .prepare("PRAGMA table_info('outbox')")
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("claimed_by")).toBe(true);
  });

  it("is idempotent across repeated startup", () => {
    t = makeTempDb();
    // re-running migrate must not throw
    expect(() => migrate(t.db)).not.toThrow();
  });
});
