import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";

const NOW = "2026-05-27T03:00:00.000Z";

function fullClassification(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) m[p] = "internal";
  return m;
}

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
    field_sensitivity: fullClassification(),
  };
}

describe("IndexWriter facade", () => {
  let t: TempDb;
  let protectedDir: string;
  let writer: IndexWriter;

  beforeEach(() => {
    t = makeTempDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-"));
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

  it("admit -> notify -> opened -> answer -> write -> resume -> ack reaches resumed", async () => {
    const { decision_id } = writer.admit(rawRequest("01HXYZABCDEFGHJKMNPQRSTV99"));
    await writer.runEffect(decision_id, "notify"); // -> notified
    writer.applyEvent(decision_id, "opened", { semanticKey: "daniel" }); // -> viewed
    writer.applyEvent(decision_id, "answer_submitted", {
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

    const view = writer.reader.get(decision_id)!;
    expect(view.status).toBe("resumed");
    expect(writer.reader.hasResponse(decision_id)).toBe(true);
  });

  it("answering a `notified` item auto-applies `opened` (notified -> viewed -> answered) — §6.2 lifecycle", () => {
    // Lifecycle bug (live e2e): the real answer path reaches a freshly `notified`
    // item (operator never separately "opened" it). applyEvent must auto-open
    // through `opened` (notified -> viewed) FIRST, then answer — never throw
    // `illegal transition: (notified) --answer_submitted-->`.
    const { decision_id } = writer.admit(rawRequest("01HXYZABCDEFGHJKMNPQRSTV97"));
    // Drive only as far as `notified` (no `opened`). The notify EVENT is applied
    // directly (not the outbox effect) so the row is `notified` without a
    // separate runEffect; this mirrors a real notified item awaiting a human.
    writer.applyEvent(decision_id, "notify", { semanticKey: "slack" });
    expect(writer.reader.get(decision_id)!.status).toBe("notified");

    const r = writer.applyEvent(decision_id, "answer_submitted", {
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
    const events = writer.reader.audit(decision_id).map((a) => a.event);
    expect(events).toContain("opened");
    expect(events).toContain("answer_submitted");
    expect(writer.reader.hasResponse(decision_id)).toBe(true);
  });

  it("answering an ALREADY-`viewed` item does NOT double-apply `opened` (no regression)", () => {
    const { decision_id } = writer.admit(rawRequest("01HXYZABCDEFGHJKMNPQRSTV96"));
    writer.applyEvent(decision_id, "notify", { semanticKey: "slack" });
    writer.applyEvent(decision_id, "opened", { semanticKey: "daniel" }); // -> viewed
    expect(writer.reader.get(decision_id)!.status).toBe("viewed");

    const r = writer.applyEvent(decision_id, "answer_submitted", {
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
    const opens = writer.reader.audit(decision_id).filter((a) => a.event === "opened");
    expect(opens).toHaveLength(1);
  });

  it("admit redacts phi before the first SQLite write (no plaintext in file)", () => {
    const raw = rawRequest("01HXYZABCDEFGHJKMNPQRSTV98") as any;
    raw.context = "PHI-VALUE-zzz";
    raw.field_sensitivity["context"] = "phi";
    writer.admit(raw);
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const files = readdirSync(t.dir).filter((f) => f.includes(".sqlite"));
    for (const f of files) {
      const bytes = require("node:fs").readFileSync(join(t.dir, f)).toString("latin1");
      expect(bytes.includes("PHI-VALUE-zzz")).toBe(false);
    }
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
