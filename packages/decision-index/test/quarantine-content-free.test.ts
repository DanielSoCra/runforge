import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore } from "@runforge/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { ingest, NotAdmittedError } from "../src/ingest.js";
import { decisions, quarantineEvents } from "../src/schema.js";
import { PROTOCOL_VERSION } from "@runforge/decision-protocol";

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
 * into quarantine_events / the database storage. Quarantine is content-free: only
 * the reason and a content-free reference are recorded.
 */
describe("quarantine is content-free (schema-invalid + protocol-version-mismatch only)", () => {
  let protectedDir: string;
  let store: ProtectedStore;
  let t: PgliteTestDb;
  let quarantine: PgQuarantine;

  beforeEach(async () => {
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-q-"));
    t = await makePgliteDb();
    store = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db });
    quarantine = new PgQuarantine(t.db);
  });
  afterEach(async () => {
    await t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  async function assertNoPlaintext(values: string[]) {
    // PGlite is in-memory (no on-disk SQLite file). Dump the raw Postgres data
    // directory (the durability equivalent of the old sqlite-file byte scan) and
    // scan its bytes for any leaked plaintext. `dumpDataDir` checkpoints before
    // serializing, so no manual WAL flush is needed.
    const dump = await t.client.dumpDataDir("none");
    const ascii = Buffer.from(await dump.arrayBuffer()).toString("latin1");
    expect(ascii.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(ascii.includes(v), `data dir leaks plaintext ${v}`).toBe(false);
    }
    const q = await t.db.select().from(quarantineEvents);
    expect(q.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(JSON.stringify(q)).not.toContain(v);
    }
  }

  it("schema-invalid request -> quarantine stores NO request content plaintext", async () => {
    const SENSITIVE_QUESTION = "Patient John Doe SSN 123-45-6789?";
    const SENSITIVE_CONTEXT = "PHI-VALUE-zzz";
    const raw = rawRequest({ question: SENSITIVE_QUESTION, context: SENSITIVE_CONTEXT });
    // Remove a required field so schema validation fails.
    delete raw.question;

    await expect(ingest(raw, { db: t.db, protectedStore: store, quarantine })).rejects.toThrow(
      NotAdmittedError,
    );
    expect(await t.db.select().from(decisions)).toHaveLength(0);
    const q = await t.db.select().from(quarantineEvents);
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe("schema_invalid");
    await assertNoPlaintext([SENSITIVE_CONTEXT]);
  });

  it("protocol_version mismatch -> quarantine stores NO request content plaintext", async () => {
    const SENSITIVE_QUESTION = "Patient Jane Roe DOB 1990-03-04?";
    const SENSITIVE_CONTEXT = "PHI-VALUE-aaa";
    const raw = rawRequest({
      protocol_version: "9.9.9",
      question: SENSITIVE_QUESTION,
      context: SENSITIVE_CONTEXT,
    });

    await expect(ingest(raw, { db: t.db, protectedStore: store, quarantine })).rejects.toThrow(
      NotAdmittedError,
    );
    expect(await t.db.select().from(decisions)).toHaveLength(0);
    const q = await t.db.select().from(quarantineEvents);
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe("protocol_version_mismatch");
    await assertNoPlaintext([SENSITIVE_CONTEXT]);
  });
});
