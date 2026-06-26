import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";
import { decisionResponses } from "../src/schema.js";

const NOW = "2026-05-27T07:00:00.000Z";

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
  };
}

// Content-agnostic ingest (sanitization stripped): an answer's chosen_option is
// persisted plainly to response_payload_json and posted to the source sink. There
// is no built-in answer redaction; that is a future configured-sanitizer concern.
describe("response_payload_json answer posting", () => {
  let t: PgliteTestDb;
  let protectedDir: string;
  let writer: IndexWriter;
  beforeEach(async () => {
    t = await makePgliteDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-rp-"));
    writer = new IndexWriter({
      db: t.db,
      protectedStore: new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db }),
      quarantine: new PgQuarantine(t.db),
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date(NOW),
      channel: "slack",
    });
  });
  afterEach(async () => {
    await t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  async function bringToAnswerable(id: string) {
    await writer.runEffect(id, "notify");
    await writer.applyEvent(id, "opened", { semanticKey: "daniel" });
  }

  it("an option answer persists response_payload_json with the chosen_option", async () => {
    const id = "01HRP000000000000000000001";
    await writer.admit(optionRequest(id));
    await bringToAnswerable(id);
    await writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r1",
      answer: { response_idempotency_key: "r1", chosen_option: "yes", answerer: "daniel", answered_at: NOW },
    });
    const resp = (await t.db.select().from(decisionResponses).where(eq(decisionResponses.decision_id, id)))[0]!;
    expect(resp.response_payload_json).toBe(JSON.stringify({ chosen_option: "yes" }));
  });

  it("the source sink receives the postable payload with hasProtectedAnswer=false", async () => {
    const id = "01HRP000000000000000000004";
    await writer.admit(optionRequest(id));
    await bringToAnswerable(id);
    await writer.applyEvent(id, "answer_submitted", {
      semanticKey: "r4",
      answer: { response_idempotency_key: "r4", chosen_option: "yes", answerer: "daniel", answered_at: NOW },
    });
    await writer.runEffect(id, "write_response");
    const sink = (writer as unknown as { outbox: { sourceSink: FakeSourceSink } }).outbox.sourceSink;
    const call = sink.calls[sink.calls.length - 1]!;
    expect(call.responsePayloadJson).toBe(JSON.stringify({ chosen_option: "yes" }));
    expect(call.hasProtectedAnswer).toBe(false);
  });
});
