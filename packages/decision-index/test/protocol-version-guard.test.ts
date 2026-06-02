import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    decision_id: "01HXYZABCDEFGHJKMNPQRSTV02",
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
 * FIX (verdict fix_before_flag_on / decision-request.ts:35): protocol_version is
 * z.string().min(1).default(PROTOCOL_VERSION) so ANY non-empty version string is
 * admitted+stored without quarantine. ingest() must enforce equality against the
 * package PROTOCOL_VERSION and quarantine a mismatch (content-free), so a
 * mis-versioned producer is rejected, not silently stored under the wrong
 * contract. (An OMITTED protocol_version still defaults to PROTOCOL_VERSION — the
 * daemon's own build-request path omits it — and must still be ADMITTED.)
 */
describe("protocol_version equality guard at ingest", () => {
  let protectedDir: string;
  let store: ProtectedStore;
  let t: TempDb;
  let quarantine: SqliteQuarantine;

  beforeEach(() => {
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-pv-"));
    t = makeTempDb();
    store = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db });
    quarantine = new SqliteQuarantine(t.db);
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  it("rejects a mismatched protocol_version -> NotAdmittedError + quarantine row, NO decisions row", () => {
    const raw = rawRequest({ protocol_version: "9.9.9" });
    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    const q = t.db.select().from(quarantineEvents).all();
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe("protocol_version_mismatch");
  });

  it("admits the matching protocol_version", () => {
    const raw = rawRequest({ protocol_version: PROTOCOL_VERSION, decision_id: "01HXYZABCDEFGHJKMNPQRSTV03" });
    const { decisionRow } = ingest(raw, { db: t.db, protectedStore: store, quarantine });
    expect(decisionRow.protocol_version).toBe(PROTOCOL_VERSION);
    expect(t.db.select().from(quarantineEvents).all()).toHaveLength(0);
  });

  it("admits an OMITTED protocol_version (schema default = PROTOCOL_VERSION) — the daemon build-request path", () => {
    const raw = rawRequest({ decision_id: "01HXYZABCDEFGHJKMNPQRSTV04" });
    delete raw.protocol_version;
    const { decisionRow } = ingest(raw, { db: t.db, protectedStore: store, quarantine });
    expect(decisionRow.protocol_version).toBe(PROTOCOL_VERSION);
    expect(t.db.select().from(quarantineEvents).all()).toHaveLength(0);
  });
});
