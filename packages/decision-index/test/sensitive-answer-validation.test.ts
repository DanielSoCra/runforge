import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { IndexWriter } from "../src/index-writer.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";
import { decisionResponses, decisions, protectedRefs } from "../src/schema.js";
import { eq } from "drizzle-orm";

const NOW = "2026-05-27T01:00:00.000Z";

function baseClassification(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) m[p] = "internal";
  return m;
}

function phiJsonRequest(): any {
  return {
    decision_id: "01HXYZABCDEFGHJKMNPQRSTV44",
    protocol_version: PROTOCOL_VERSION,
    source_url: "https://example.test/issues/1",
    source_etag: "etag-1",
    source_event_id: "evt-1",
    deployment: "dep-1",
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
    risk_class: "P1",
    question: "Enter patient record",
    context: "ctx",
    options: [{ id: "x", label: "X" }],
    recommended_option: "x",
    consequence_of_no_answer: "paused",
    reversibility: "reversible",
    expires_at: "2026-06-01T00:00:00.000Z",
    answer_schema: {
      kind: "json",
      schema: {
        type: "object",
        required: ["patient", "dob"],
        properties: {
          patient: { type: "string" },
          dob: { type: "string" },
          age: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    resume_mode: "mid_run",
    idempotency_key: "idem-1",
    trace_id: "trace-1",
    agent_version: "1.0.0",
    skill_version: "0.1.0",
    field_sensitivity: baseClassification(),
  };
}

/**
 * IMPORTANT I7 — a sensitive (phi/secret) structured JSON answer must be
 * validated against answer_schema (Ajv) IN MEMORY before redaction to
 * answer_ref. The prior code redacted first, then validateAnswer skipped Ajv
 * because answer_value was gone, so an INVALID PHI answer was accepted.
 */
describe("sensitive JSON answer is Ajv-validated before redaction (Finding I7)", () => {
  let t: TempDb;
  let protectedDir: string;
  let writer: IndexWriter;
  let id: string;

  beforeEach(async () => {
    t = makeTempDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-i7-"));
    const protectedStore = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db });
    writer = new IndexWriter({
      db: t.db,
      protectedStore,
      quarantine: new SqliteQuarantine(t.db),
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date(NOW),
      channel: "slack",
    });
    id = writer.admit(phiJsonRequest()).decision_id;
    await writer.runEffect(id, "notify");
    writer.applyEvent(id, "opened", { semanticKey: "daniel" });
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  it("an INVALID PHI JSON answer (wrong type, missing required) is REJECTED, item stays viewed, no response row, no plaintext", () => {
    const INVALID_PHI = { patient: 12345, age: -7 }; // patient wrong type, missing dob, age < min
    const r = writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-bad",
      answer: {
        response_idempotency_key: "resp-bad",
        answer_value: INVALID_PHI,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });

    // rejected, not applied
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/schema/i);
    expect(r.status).toBe("viewed");

    // no response row written
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
    // item still viewed
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("viewed");

    // no plaintext reached SQLite, and no orphaned protected_refs row for a rejected answer
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes("12345"), `${f} leaks rejected answer fragment`).toBe(false);
    }
  });

  it("a sensitive JSON answer supplied directly as answer_ref WITHOUT validate_value is REJECTED (Ajv cannot be bypassed)", () => {
    // Residual I7: a caller pre-redacts to answer_ref and supplies neither
    // answer_value nor validate_value. The prior code skipped Ajv entirely
    // (toValidate undefined) and HMACed + persisted an UNVALIDATED sensitive
    // answer. A sensitive JSON answer_ref with no validate_value must be rejected.
    const r = writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-ref-noval",
      answer: {
        response_idempotency_key: "resp-ref-noval",
        answer_ref: "protected://abc/def",
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/valid/i);
    expect(r.status).toBe("viewed");
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
  });

  it("a sensitive JSON answer_ref whose validate_value VIOLATES the schema is REJECTED", () => {
    const INVALID = { patient: 999, age: -1 }; // wrong type, missing dob, age<min
    const r = writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-ref-bad",
      answer: {
        response_idempotency_key: "resp-ref-bad",
        answer_ref: "protected://abc/bad",
        validate_value: INVALID,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/schema/i);
    expect(r.status).toBe("viewed");
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
  });

  it("a sensitive JSON answer_ref whose validate_value SATISFIES the schema is accepted, no plaintext/validate_value persisted", () => {
    const VALID = { patient: "Jane Roe", dob: "1990-03-04", age: 36 };
    const r = writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-ref-ok",
      answer: {
        response_idempotency_key: "resp-ref-ok",
        answer_ref: "protected://abc/ok",
        validate_value: VALID,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(true);
    expect(r.status).toBe("answered_pending_source_write");
    const resp = t.db.select().from(decisionResponses).all()[0]!;
    expect(resp.answer_ref).toBe("protected://abc/ok");

    // neither the plaintext nor validate_value bytes reach SQLite
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes("Jane Roe"), `${f} leaks validate_value plaintext`).toBe(false);
    }
  });

  it("a VALID PHI JSON answer is still accepted, redacted to a ref, item advances", () => {
    const VALID_PHI = { patient: "John Doe", dob: "1980-01-02", age: 45 };
    const r = writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-ok",
      answer: {
        response_idempotency_key: "resp-ok",
        answer_value: VALID_PHI,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(true);
    expect(r.status).toBe("answered_pending_source_write");
    const resp = t.db.select().from(decisionResponses).all()[0]!;
    expect(resp.answer_ref).toMatch(/^protected:\/\//);

    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes("John Doe"), `${f} leaks valid answer plaintext`).toBe(false);
    }
  });
});
