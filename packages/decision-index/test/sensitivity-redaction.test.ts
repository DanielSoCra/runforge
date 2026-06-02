import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore, ProtectedIntegrityError } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { ingest, NotAdmittedError } from "../src/ingest.js";
import { decisions, protectedRefs, quarantineEvents } from "../src/schema.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";

const SECRET_VALUE = "SUPER-SECRET-TOKEN-zzz-9999";
const PHI_VALUE = "patient John Doe DOB 1980-01-02";

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

describe("protected store (AES-256-GCM)", () => {
  let protectedDir: string;
  let store: ProtectedStore;
  let t: TempDb;

  beforeEach(() => {
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-"));
    t = makeTempDb();
    store = new ProtectedStore({
      key: TEST_PROTECTED_KEY,
      dir: protectedDir,
      db: t.db,
    });
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  it("encrypt -> decrypt round-trip", () => {
    const ref = store.put({
      decision_id: "d1",
      field: "context",
      class: "secret",
      plaintext: SECRET_VALUE,
    });
    expect(ref).toMatch(/^protected:\/\//);
    expect(store.get(ref)).toBe(SECRET_VALUE);
  });

  it("inserts a protected_refs row (ulid, decision_id, field, class)", () => {
    const ref = store.put({
      decision_id: "d1",
      field: "context",
      class: "phi",
      plaintext: PHI_VALUE,
    });
    const ulid = ref.replace("protected://", "");
    const rows = t.db
      .select()
      .from(protectedRefs)
      .all()
      .filter((r) => r.ulid === ulid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("context");
    expect(rows[0]!.class).toBe("phi");
  });

  it("tampered blob -> integrity error", () => {
    const ref = store.put({
      decision_id: "d1",
      field: "context",
      class: "secret",
      plaintext: SECRET_VALUE,
    });
    const ulid = ref.replace("protected://", "");
    const blobPath = join(protectedDir, `${ulid}.enc`);
    const buf = readFileSync(blobPath);
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
    rmSync(blobPath);
    require("node:fs").writeFileSync(blobPath, buf);
    expect(() => store.get(ref)).toThrow(ProtectedIntegrityError);
    expect(() => store.verifyIntegrity(ref)).toThrow(ProtectedIntegrityError);
  });
});

describe("fail-closed ingestion", () => {
  let protectedDir: string;
  let store: ProtectedStore;
  let t: TempDb;
  let quarantine: SqliteQuarantine;

  beforeEach(() => {
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-"));
    t = makeTempDb();
    store = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db });
    quarantine = new SqliteQuarantine(t.db);
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  it("unclassified phi -> quarantined content-free, NOT admitted", () => {
    const raw = rawRequest();
    // mark context as phi but DROP its classification (incomplete map)
    raw.context = PHI_VALUE;
    delete raw.field_sensitivity["context"];

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );

    // not admitted
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    // quarantined, content-free
    const q = t.db.select().from(quarantineEvents).all();
    expect(q).toHaveLength(1);
    expect(q[0]!.missing_paths).toContain("context");
    // the raw PHI value must NOT appear anywhere in the quarantine record
    expect(JSON.stringify(q[0])).not.toContain(PHI_VALUE);
  });

  it("admitted row has protected:// refs + matching protected_refs, no plaintext", () => {
    const raw = rawRequest();
    raw.context = PHI_VALUE;
    raw.question = SECRET_VALUE;
    raw.field_sensitivity["context"] = "phi";
    raw.field_sensitivity["question"] = "secret";

    const { decisionRow } = ingest(raw, { db: t.db, protectedStore: store, quarantine });

    expect(decisionRow.context).toMatch(/^protected:\/\//);
    expect(decisionRow.question).toMatch(/^protected:\/\//);
    expect(decisionRow.context).not.toContain(PHI_VALUE);
    expect(decisionRow.question).not.toContain(SECRET_VALUE);

    const refs = t.db.select().from(protectedRefs).all();
    expect(refs.length).toBe(2);
    const fields = refs.map((r) => r.field).sort();
    expect(fields).toEqual(["context", "question"]);
  });

  it("the SQLite files contain no plaintext and no plaintext hash", () => {
    const raw = rawRequest();
    raw.context = PHI_VALUE;
    raw.question = SECRET_VALUE;
    raw.field_sensitivity["context"] = "phi";
    raw.field_sensitivity["question"] = "secret";

    const { decisionRow } = ingest(raw, { db: t.db, protectedStore: store, quarantine });
    // persist the redacted row
    t.db.insert(decisions).values(decisionRow).run();

    // force WAL checkpoint so any plaintext would be flushed to the main file too
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");

    // a plaintext hash a naive impl might store
    const crypto = require("node:crypto");
    const phiHash = crypto.createHash("sha256").update(PHI_VALUE).digest("hex");
    const secretHash = crypto.createHash("sha256").update(SECRET_VALUE).digest("hex");

    const files = readdirSync(t.dir).filter(
      (f) => f.endsWith(".sqlite") || f.includes(".sqlite-"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = readFileSync(join(t.dir, f));
      const ascii = bytes.toString("latin1");
      expect(ascii.includes(PHI_VALUE), `${f} leaks PHI plaintext`).toBe(false);
      expect(ascii.includes(SECRET_VALUE), `${f} leaks secret plaintext`).toBe(false);
      expect(ascii.includes(phiHash), `${f} leaks PHI plaintext hash`).toBe(false);
      expect(ascii.includes(secretHash), `${f} leaks secret plaintext hash`).toBe(false);
    }
  });

  it("A8: classifying source_url phi/secret FAIL-CLOSES to quarantine (operational locator, never redacted)", () => {
    const PHI_URL = "https://example.test/patient/JohnDoe-DOB-1980-01-02";
    const raw = rawRequest();
    raw.source_url = PHI_URL;
    raw.field_sensitivity["source_url"] = "phi";

    // source_url is OPERATIONAL — a phi/secret class cannot be protected without
    // breaking the freshness probe + comment post, so admission fails-closed.
    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(NotAdmittedError);
    // and no plaintext locator reached quarantine_events.
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes(PHI_URL), `${f} leaks PHI source_url`).toBe(false);
    }
  });

  it("an admitted item ALWAYS retains a usable plaintext source_url (operational)", () => {
    const URL = "https://example.test/issues/42";
    const raw = rawRequest();
    raw.source_url = URL;
    // even if other observability fields are sensitive, source_url stays plaintext.
    raw.field_sensitivity["source_event_id"] = "phi";
    const { decisionRow } = ingest(raw, { db: t.db, protectedStore: store, quarantine });
    expect(decisionRow.source_url).toBe(URL);
    expect(decisionRow.source_url).not.toMatch(/^protected:\/\//);
    // source_event_id (still redactable) IS protected.
    expect(decisionRow.source_event_id).toMatch(/^protected:\/\//);
  });

  it("CRITICAL 2: classified phi on an OPERATIONAL field (run_id) cannot be protected without breaking logic -> FAIL to quarantine, NOT admitted", () => {
    const PHI_RUN = "run-patient-JohnDoe-DOB-1980-01-02";
    const raw = rawRequest();
    raw.run_id = PHI_RUN;
    raw.field_sensitivity["run_id"] = "phi";

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );

    // not admitted
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    // quarantined content-free; the raw run_id value must NOT appear
    const q = t.db.select().from(quarantineEvents).all();
    expect(q).toHaveLength(1);
    expect(q[0]!.missing_paths).toContain("run_id");
    expect(JSON.stringify(q[0])).not.toContain(PHI_RUN);
  });

  it("CRITICAL 2: classified secret on answer_schema (operational) -> FAIL to quarantine", () => {
    const raw = rawRequest();
    raw.field_sensitivity["answer_schema"] = "secret";
    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
  });

  it("CRITICAL 1: classified phi on deployment (operational filter key) -> FAIL to quarantine, NOT admitted", () => {
    const PHI_DEPLOYMENT = "deploy-patient-JohnDoe-DOB-1980-01-02";
    const raw = rawRequest();
    raw.deployment = PHI_DEPLOYMENT;
    raw.field_sensitivity["deployment"] = "phi";

    expect(() => ingest(raw, { db: t.db, protectedStore: store, quarantine })).toThrow(
      NotAdmittedError,
    );

    // not admitted — a protected://<ulid> ref for deployment would be rendered as
    // a plaintext token on the filter/card/detail and break filtering.
    expect(t.db.select().from(decisions).all()).toHaveLength(0);
    const q = t.db.select().from(quarantineEvents).all();
    expect(q).toHaveLength(1);
    expect(q[0]!.missing_paths).toContain("deployment");
    expect(JSON.stringify(q[0])).not.toContain(PHI_DEPLOYMENT);
  });

  it("CRITICAL 1: an admitted item ALWAYS retains a plain (non-protected) deployment for the filter/card", () => {
    const DEPLOYMENT = "patient-app";
    const raw = rawRequest();
    raw.deployment = DEPLOYMENT;
    // even with another redactable field sensitive, deployment stays plaintext.
    raw.field_sensitivity["context"] = "phi";
    const { decisionRow } = ingest(raw, { db: t.db, protectedStore: store, quarantine });
    expect(decisionRow.deployment).toBe(DEPLOYMENT);
    expect(decisionRow.deployment).not.toMatch(/^protected:\/\//);
  });
});
