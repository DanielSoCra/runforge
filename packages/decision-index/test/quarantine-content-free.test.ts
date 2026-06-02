import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { ingest, NotAdmittedError } from "../src/ingest.js";
import { decisions, quarantineEvents } from "../src/schema.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";

function baseClassification(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) m[p] = "internal";
  return m;
}

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
    field_sensitivity: baseClassification(),
    ...overrides,
  };
}

/**
 * CRITICAL C2 — the QUARANTINE path must never write a classified phi/secret
 * field value as plaintext into quarantine_events / the SQLite file. The prior
 * fix redacted the ADMITTED path but the failed-admission (quarantine) path
 * still forwarded the RAW request.source_url / request.source_event_id.
 */
describe("quarantine is content-free even for classified phi fields (Finding C2)", () => {
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

  it("incomplete classification + source_url classified phi -> quarantine stores NO source_url plaintext", () => {
    const PHI_URL = "https://example.test/patient/JohnDoe-DOB-1980-01-02";
    const PHI_EVENT = "evt-patient-JaneRoe-SSN-000-00-0000";
    const raw = rawRequest();
    raw.source_url = PHI_URL;
    raw.source_event_id = PHI_EVENT;
    raw.field_sensitivity["source_url"] = "phi";
    raw.field_sensitivity["source_event_id"] = "phi";
    // make admission FAIL on the completeness gate (drop an unrelated path)
    delete raw.field_sensitivity["context"];

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    assertNoPlaintext([PHI_URL, PHI_EVENT]);
  });

  it("incomplete classification + source_url UNCLASSIFIED (missing entry) -> fail-closed, quarantine stores NO source_url plaintext", () => {
    // Residual C2: when field_sensitivity has NO entry for source_url, the prior
    // quarantineId() returned the RAW value (cls undefined -> not isProtected ->
    // forwarded). Unknown classification must be treated as SENSITIVE (fail-closed).
    const UNKNOWN_URL = "https://example.test/patient/UnknownClass-DOB-1975-09-09";
    const UNKNOWN_EVENT = "evt-unknown-class-SSN-111-22-3333";
    const raw = rawRequest();
    raw.source_url = UNKNOWN_URL;
    raw.source_event_id = UNKNOWN_EVENT;
    // No explicit class for source_url / source_event_id -> incomplete map.
    delete raw.field_sensitivity["source_url"];
    delete raw.field_sensitivity["source_event_id"];

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    assertNoPlaintext([UNKNOWN_URL, UNKNOWN_EVENT]);
  });

  it("operational-sensitive failure + source_url classified secret -> quarantine stores NO source_url plaintext", () => {
    const SECRET_URL = "https://example.test/secret-token-abc-99999";
    const raw = rawRequest();
    raw.source_url = SECRET_URL;
    raw.field_sensitivity["source_url"] = "secret";
    // trigger the operational-sensitive quarantine branch
    raw.field_sensitivity["run_id"] = "phi";

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    assertNoPlaintext([SECRET_URL]);
  });
});
