import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { IndexWriter } from "../src/index-writer.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";
import { decisionResponses } from "../src/schema.js";

const NOW = "2026-05-27T01:00:00.000Z";
const PHI_ANSWER = { patient: "John Doe", dob: "1980-01-02", note: "diagnosis X" };

function baseClassification(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) m[p] = "internal";
  return m;
}

function phiJsonRequest(): any {
  return {
    decision_id: "01HXYZABCDEFGHJKMNPQRSTV33",
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
        properties: { patient: { type: "string" }, dob: { type: "string" }, note: { type: "string" } },
        additionalProperties: true,
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

describe("sensitive JSON answer leaves no plaintext-derived hash (Finding 3)", () => {
  let t: TempDb;
  let protectedDir: string;
  let writer: IndexWriter;

  beforeEach(() => {
    t = makeTempDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-ans-"));
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
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  function answerPhi(key = "resp-1") {
    return writer.applyEvent(id, "answer_submitted", {
      semanticKey: key,
      answer: {
        response_idempotency_key: key,
        answer_value: PHI_ANSWER,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
  }

  let id: string;
  beforeEach(async () => {
    id = writer.admit(phiJsonRequest()).decision_id;
    await writer.runEffect(id, "notify");
    writer.applyEvent(id, "opened", { semanticKey: "daniel" });
  });

  it("PHI answer accepted; SQLite contains NO plaintext and NO plaintext-derived hash", () => {
    const r = answerPhi();
    expect(r.applied).toBe(true);
    expect(r.status).toBe("answered_pending_source_write");

    // stored response carries an answer_ref (protected), not plaintext
    const resp = t.db.select().from(decisionResponses).all()[0]!;
    expect(resp.answer_ref).toMatch(/^protected:\/\//);

    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");

    // the naive plaintext-derived hashes a weak impl would store
    const plaintext = JSON.stringify(PHI_ANSWER);
    const sha = createHash("sha256").update(plaintext).digest("hex");
    // also the canonicalized form a prior impl hashed: {answer_ref:null,answer_value:{...}}
    const canonicalPayload =
      `{"answer_ref":null,"answer_value":{"dob":${JSON.stringify(PHI_ANSWER.dob)},"note":${JSON.stringify(PHI_ANSWER.note)},"patient":${JSON.stringify(PHI_ANSWER.patient)}}}`;
    const canonicalSha = createHash("sha256").update(canonicalPayload).digest("hex");

    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes(plaintext), `${f} leaks answer plaintext`).toBe(false);
      expect(ascii.includes("John Doe"), `${f} leaks answer plaintext fragment`).toBe(false);
      expect(ascii.includes(sha), `${f} leaks SHA-256 of plaintext`).toBe(false);
      expect(ascii.includes(canonicalSha), `${f} leaks SHA-256 of canonical plaintext payload`).toBe(false);
    }
  });

  it("answered-once idempotency holds across a replay of the same PHI answer", () => {
    const r1 = answerPhi("resp-1");
    expect(r1.applied).toBe(true);
    // replay same key + same answer -> idempotent no-op, still exactly one row.
    // (Each redaction mints a FRESH protected ref, so this proves the
    // response_hash is the STABLE logical-value HMAC, NOT the volatile ref.)
    const r2 = answerPhi("resp-1");
    expect(r2.applied).toBe(false);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(1);
  });

  it("CONFLICT detected for a DIFFERENT PHI answer under the SAME key (not masked by the fresh-ref replay path)", async () => {
    const { AnsweredOnceConflictError } = await import("../src/state-machine.js");
    const r1 = answerPhi("resp-1");
    expect(r1.applied).toBe(true);
    // a SECOND, DIFFERENT phi answer under the SAME idempotency key must raise the
    // answered-once conflict — the logical-value HMAC differs even though the ref
    // is volatile, so the conflict-bypass fix surfaces it instead of dropping it.
    expect(() =>
      writer.applyEvent(id, "answer_submitted", {
        semanticKey: "resp-1",
        answer: {
          response_idempotency_key: "resp-1",
          answer_value: { patient: "Jane Roe", dob: "1990-09-09", note: "diagnosis Y" },
          answer_sensitivity: "phi",
          answerer: "daniel",
          answered_at: NOW,
        },
      }),
    ).toThrow(AnsweredOnceConflictError);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(1);
  });

  it("a sensitive answer carrying RAW answer_value (no ref) at the apply layer is rejected", async () => {
    // bypass the writer redaction: call the state machine directly with a raw
    // sensitive value and a hasher -> must be rejected, never stored.
    const { apply } = await import("../src/state-machine.js");
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-raw",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-raw",
        answer_value: PHI_ANSWER,
        answer_sensitivity: "secret",
        answerer: "daniel",
        answered_at: NOW,
      },
      responseHash: (c: string) => createHash("sha256").update("keyed-" + c).digest("hex"),
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/answer_ref/);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
  });
});
