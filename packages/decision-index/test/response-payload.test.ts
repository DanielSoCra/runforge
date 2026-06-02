import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";
import { decisionResponses } from "../src/schema.js";

const NOW = "2026-05-27T07:00:00.000Z";
const PHI = { patient: "Jane Roe", dob: "1990-03-04" };

function fullClassification(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) m[p] = "internal";
  return m;
}

function optionRequest(id: string): any {
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
    field_sensitivity: fullClassification(),
  };
}

function phiJsonRequest(id: string): any {
  return {
    ...optionRequest(id),
    answer_schema: {
      kind: "json",
      schema: {
        type: "object",
        required: ["patient", "dob"],
        properties: { patient: { type: "string" }, dob: { type: "string" } },
        additionalProperties: false,
      },
    },
  };
}

describe("response_payload_json for PHI-safe answer posting (A6)", () => {
  let t: TempDb;
  let protectedDir: string;
  let writer: IndexWriter;
  beforeEach(() => {
    t = makeTempDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-rp-"));
    writer = new IndexWriter({
      db: t.db,
      protectedStore: new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db }),
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

  async function bringToAnswerable(id: string) {
    await writer.runEffect(id, "notify");
    writer.applyEvent(id, "opened", { semanticKey: "daniel" });
  }

  it("a non-sensitive option answer persists response_payload_json with the chosen_option", async () => {
    const id = "01HRP000000000000000000001";
    writer.admit(optionRequest(id));
    await bringToAnswerable(id);
    writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r1",
      answer: { response_idempotency_key: "r1", chosen_option: "yes", answerer: "daniel", answered_at: NOW },
    });
    const resp = t.db.select().from(decisionResponses).where(eq(decisionResponses.decision_id, id)).all()[0]!;
    expect(resp.response_payload_json).toBe(JSON.stringify({ chosen_option: "yes" }));
  });

  it("a phi answer leaves response_payload_json NULL (only answer_ref)", async () => {
    const id = "01HRP000000000000000000002";
    writer.admit(phiJsonRequest(id));
    await bringToAnswerable(id);
    writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r2",
      answer: {
        response_idempotency_key: "r2",
        answer_value: PHI,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    const resp = t.db.select().from(decisionResponses).where(eq(decisionResponses.decision_id, id)).all()[0]!;
    expect(resp.response_payload_json).toBeNull();
    expect(resp.answer_ref).toMatch(/^protected:\/\//);
  });

  it("byte-scan: no phi plaintext appears in response_payload_json (or anywhere in SQLite)", async () => {
    const id = "01HRP000000000000000000003";
    writer.admit(phiJsonRequest(id));
    await bringToAnswerable(id);
    writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r3",
      answer: {
        response_idempotency_key: "r3",
        answer_value: PHI,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes("Jane Roe"), `${f} leaks phi in response_payload_json`).toBe(false);
    }
  });

  it("the source sink receives the postable payload (non-sensitive) and hasProtectedAnswer=false", async () => {
    const id = "01HRP000000000000000000004";
    writer.admit(optionRequest(id));
    await bringToAnswerable(id);
    writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r4",
      answer: { response_idempotency_key: "r4", chosen_option: "yes", answerer: "daniel", answered_at: NOW },
    });
    await writer.runEffect(id, "write_response");
    const sink = (writer as unknown as { outbox: { sourceSink: FakeSourceSink } }).outbox.sourceSink;
    const call = sink.calls[sink.calls.length - 1]!;
    expect(call.responsePayloadJson).toBe(JSON.stringify({ chosen_option: "yes" }));
    expect(call.hasProtectedAnswer).toBe(false);
  });

  it("the source sink receives hasProtectedAnswer=true and null payload for a phi answer", async () => {
    const id = "01HRP000000000000000000005";
    writer.admit(phiJsonRequest(id));
    await bringToAnswerable(id);
    writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r5",
      answer: {
        response_idempotency_key: "r5",
        answer_value: PHI,
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    await writer.runEffect(id, "write_response");
    const sink = (writer as unknown as { outbox: { sourceSink: FakeSourceSink } }).outbox.sourceSink;
    const call = sink.calls[sink.calls.length - 1]!;
    expect(call.responsePayloadJson).toBeNull();
    expect(call.hasProtectedAnswer).toBe(true);
    expect(call.answerRef).toMatch(/^protected:\/\//);
  });
});
