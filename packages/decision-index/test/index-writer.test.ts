import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";

const NOW = "2026-05-27T03:00:00.000Z";

function rawRequest(id: string): unknown {
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

describe("IndexWriter facade", () => {
  let t: PgliteTestDb;
  let protectedDir: string;
  let writer: IndexWriter;

  beforeEach(async () => {
    t = await makePgliteDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-"));
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

  it("admit -> notify -> opened -> answer -> write -> resume -> ack reaches resumed", async () => {
    const { decision_id } = await writer.admit(rawRequest("01HXYZABCDEFGHJKMNPQRSTV99"));
    await writer.runEffect(decision_id, "notify"); // -> notified
    await writer.applyEvent(decision_id, "opened", { semanticKey: "daniel" }); // -> viewed
    await writer.applyEvent(decision_id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    }); // -> answered_pending_source_write
    const w = await writer.runEffect(decision_id, "write_response"); // -> source_written
    expect(w.status).toBe("source_written");
    // A4: a confirmed resume lands directly in terminal `resumed` (atomic
    // resume_dispatch + resume_ack); no separate ack step needed.
    const r = await writer.runEffect(decision_id, "resume"); // -> resumed
    expect(r.status).toBe("resumed");

    const view = (await writer.reader.get(decision_id))!;
    expect(view.status).toBe("resumed");
    expect(await writer.reader.hasResponse(decision_id)).toBe(true);
  });

  it("answering a `notified` item auto-applies `opened` (notified -> viewed -> answered) — §6.2 lifecycle", async () => {
    // Lifecycle bug (live e2e): the real answer path reaches a freshly `notified`
    // item (operator never separately "opened" it). applyEvent must auto-open
    // through `opened` (notified -> viewed) FIRST, then answer — never throw
    // `illegal transition: (notified) --answer_submitted-->`.
    const { decision_id } = await writer.admit(rawRequest("01HXYZABCDEFGHJKMNPQRSTV97"));
    // Drive only as far as `notified` (no `opened`). The notify EVENT is applied
    // directly (not the outbox effect) so the row is `notified` without a
    // separate runEffect; this mirrors a real notified item awaiting a human.
    await writer.applyEvent(decision_id, "notify", { semanticKey: "slack" });
    expect((await writer.reader.get(decision_id))!.status).toBe("notified");

    const r = await writer.applyEvent(decision_id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(true);
    expect(r.rejected).toBeUndefined();
    expect(r.status).toBe("answered_pending_source_write");

    // the auto-`opened` step is recorded (deterministic semantic key = answerer).
    const events = (await writer.reader.audit(decision_id)).map((a) => a.event);
    expect(events).toContain("opened");
    expect(events).toContain("answer_submitted");
    expect(await writer.reader.hasResponse(decision_id)).toBe(true);
  });

  it("answering an ALREADY-`viewed` item does NOT double-apply `opened` (no regression)", async () => {
    const { decision_id } = await writer.admit(rawRequest("01HXYZABCDEFGHJKMNPQRSTV96"));
    await writer.applyEvent(decision_id, "notify", { semanticKey: "slack" });
    await writer.applyEvent(decision_id, "opened", { semanticKey: "daniel" }); // -> viewed
    expect((await writer.reader.get(decision_id))!.status).toBe("viewed");

    const r = await writer.applyEvent(decision_id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(true);
    expect(r.status).toBe("answered_pending_source_write");
    // exactly ONE `opened` event — the answer path did not re-open the viewed item.
    const opens = (await writer.reader.audit(decision_id)).filter((a) => a.event === "opened");
    expect(opens).toHaveLength(1);
  });

  it("the public package surface exports only the reader for non-writers (no raw write internals)", async () => {
    const pkg = await import("../src/index.js");
    // read + writer facade + gated factory are exported
    expect(pkg.IndexWriter).toBeDefined();
    expect(pkg.ReadModel).toBeDefined();
    expect(pkg.createIndexWriter).toBeDefined();
    expect(pkg.openReadOnlyDb).toBeDefined();
    // I7: the WRITABLE connection opener is NOT on the public surface.
    expect((pkg as Record<string, unknown>).openDb).toBeUndefined();
    // raw direct-write helpers must NOT be on the public surface
    expect((pkg as Record<string, unknown>).decisions).toBeUndefined();
    expect((pkg as Record<string, unknown>).withTx).toBeUndefined();
  });
});
