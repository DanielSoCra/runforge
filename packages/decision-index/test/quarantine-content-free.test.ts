import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import { SqliteQuarantine } from "../src/quarantine.js";
import { ingest, NotAdmittedError } from "../src/ingest.js";
import { decisions, quarantineEvents } from "../src/schema.js";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";

function rawRequest(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    decision_id: "01HXYZABCDEFGHJKMNPQRSTV01",
    protocol_version: PROTOCOL_VERSION,
    source_url: "https://example.test/issues/1",
    source_etag: "etag-1",
    source_event_id: "evt-1",
    deployment: "dep-1",
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
    risk_class: "P1",
    question: "Proceed?",
    context: "ctx",
    options: [{ id: "yes", label: "Yes" }],
    recommended_option: "yes",
    consequence_of_no_answer: "stays paused",
    reversibility: "reversible",
    expires_at: "2026-06-01T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: "mid_run",
    idempotency_key: "idem-1",
    trace_id: "trace-1",
    agent_version: "1.0.0",
    skill_version: "0.1.0",
    ...overrides,
  };
}

/**
 * CRITICAL C2 — the QUARANTINE path must never write request content as plaintext
 * into quarantine_events / the SQLite file. Quarantine is content-free: only the
 * reason and a content-free reference are recorded.
 */
describe("quarantine is content-free (schema-invalid + protocol-version-mismatch only)", () => {
  let protectedDir: string;
  let store: ProtectedStore;
  let t: TempDb;
  let quarantine: SqliteQuarantine;

  beforeEach(() => {
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-q-"));
    t = makeTempDb();
    store = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db });
    quarantine = new SqliteQuarantine(t.db);
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  function assertNoPlaintext(values: string[]) {
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      for (const v of values) {
        expect(ascii.includes(v), `${f} leaks plaintext ${v}`).toBe(false);
      }
    }
    const q = t.db.select().from(quarantineEvents).all();
    expect(q.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(JSON.stringify(q)).not.toContain(v);
    }
  }

  it("schema-invalid request -> quarantine stores NO request content plaintext", () => {
    const SENSITIVE_QUESTION = "Patient John Doe SSN 123-45-6789?";
    const SENSITIVE_CONTEXT = "PHI-VALUE-zzz";
    const raw = rawRequest({ question: SENSITIVE_QUESTION, context: SENSITIVE_CONTEXT });
    // Remove a required field so schema validation fails.
    delete raw.question;

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    const q = t.db.select().from(quarantineEvents).all();
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe("schema_invalid");
    assertNoPlaintext([SENSITIVE_CONTEXT]);
  });

  it("protocol_version mismatch -> quarantine stores NO request content plaintext", () => {
    const SENSITIVE_QUESTION = "Patient Jane Roe DOB 1990-03-04?";
    const SENSITIVE_CONTEXT = "PHI-VALUE-aaa";
    const raw = rawRequest({
      protocol_version: "9.9.9",
      question: SENSITIVE_QUESTION,
      context: SENSITIVE_CONTEXT,
    });

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    const q = t.db.select().from(quarantineEvents).all();
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe("protocol_version_mismatch");
    assertNoPlaintext([SENSITIVE_CONTEXT]);
  });
});
