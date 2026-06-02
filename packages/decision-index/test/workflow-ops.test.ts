import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "../src/protected-store.js";
import { SqliteQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { decisions, auditLog } from "../src/schema.js";
import { eq } from "drizzle-orm";
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

describe("guarded workflow ops (pin/mute/defer/need_more_context) — slice 4", () => {
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

  /** Drive a fresh item to `notified` (awaiting a human). */
  async function seedNotified(id: string): Promise<string> {
    const { decision_id } = writer.admit(rawRequest(id));
    await writer.runEffect(decision_id, "notify");
    expect(writer.reader.get(decision_id)!.status).toBe("notified");
    return decision_id;
  }

  function row(id: string) {
    return t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
  }
  function auditFor(id: string) {
    return t.db.select().from(auditLog).all().filter((a) => a.decision_id === id);
  }

  it("pin sets the pinned column + appends a redacted audit row (no status change)", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000P1");
    const r = writer.pin(id, { actor: "daniel" });
    expect(r.applied).toBe(true);
    expect(r.status).toBe("notified");
    expect(row(id).pinned).toBe(true);
    expect(row(id).status).toBe("notified"); // NOT a §6.2 transition
    const audit = auditFor(id).filter((a) => a.event === "pin");
    expect(audit.length).toBe(1);
    expect(audit[0]!.actor).toBe("daniel");
    expect(audit[0]!.from_status).toBe("notified");
    expect(audit[0]!.to_status).toBe("notified");
  });

  it("mute sets the muted column + audit", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000M1");
    const r = writer.mute(id, { actor: "daniel" });
    expect(r.applied).toBe(true);
    expect(row(id).muted).toBe(true);
    expect(auditFor(id).filter((a) => a.event === "mute").length).toBe(1);
  });

  it("defer sets deferred_until + audit (with the chosen timestamp)", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000D1");
    const until = "2026-06-15T00:00:00.000Z";
    const r = writer.defer(id, until, { actor: "daniel" });
    expect(r.applied).toBe(true);
    expect(row(id).deferred_until).toBe(until);
    const audit = auditFor(id).filter((a) => a.event === "defer");
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]!.detail_json!)).toEqual({ until });
  });

  it("need_more_context records its redacted audit row and changes NO column", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000N1");
    const before = row(id);
    const r = writer.needMoreContext(id, { actor: "daniel" });
    expect(r.applied).toBe(true);
    const after = row(id);
    expect(after.pinned).toBe(before.pinned);
    expect(after.muted).toBe(before.muted);
    expect(after.deferred_until).toBe(before.deferred_until);
    expect(after.status).toBe("notified");
    expect(auditFor(id).filter((a) => a.event === "need_more_context").length).toBe(1);
  });

  it("all four ops apply on a `viewed` item", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000V1");
    writer.applyEvent(id, "opened", { semanticKey: "daniel" }); // -> viewed
    expect(writer.reader.get(id)!.status).toBe("viewed");
    expect(writer.pin(id).applied).toBe(true);
    expect(writer.mute(id).applied).toBe(true);
    expect(writer.defer(id, "2026-07-01T00:00:00.000Z").applied).toBe(true);
    expect(writer.needMoreContext(id).applied).toBe(true);
    expect(row(id).status).toBe("viewed");
  });

  it("rejects/no-ops on a terminal `resumed` item for ALL four ops (no mutation, no audit)", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000R1");
    writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: { response_idempotency_key: "resp-1", chosen_option: "yes", answerer: "daniel", answered_at: NOW },
    });
    await writer.runEffect(id, "write_response");
    await writer.runEffect(id, "resume");
    expect(writer.reader.get(id)!.status).toBe("resumed");

    const auditBefore = auditFor(id).length;
    for (const op of [
      () => writer.pin(id),
      () => writer.mute(id),
      () => writer.defer(id, "2026-07-01T00:00:00.000Z"),
      () => writer.needMoreContext(id),
    ]) {
      const r = op();
      expect(r.applied).toBe(false);
      expect(r.reason).toBe("not_view_state");
    }
    // No mutation, no audit row appended.
    expect(row(id).pinned).toBe(false);
    expect(row(id).muted).toBe(false);
    expect(row(id).deferred_until).toBe(null);
    expect(auditFor(id).length).toBe(auditBefore);
  });

  it("rejects/no-ops on a `superseded` item", async () => {
    const id = await seedNotified("01HWORKFLOW0000000000000S1");
    // supersede via an observed etag change.
    writer.applyEvent(id, "source_superseded", { semanticKey: "etag-2", superseded_by: "etag-2" });
    expect(writer.reader.get(id)!.status).toBe("superseded");
    expect(writer.pin(id).applied).toBe(false);
    expect(writer.mute(id).reason).toBe("not_view_state");
    expect(row(id).pinned).toBe(false);
  });

  it("rejects/no-ops on a `detected` (not-yet-notified, in-flight) item", () => {
    const { decision_id } = writer.admit(rawRequest("01HWORKFLOW0000000000000C1"));
    expect(writer.reader.get(decision_id)!.status).toBe("detected");
    const r = writer.pin(decision_id);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("not_view_state");
  });

  it("rejects on an unknown decision id (no throw)", () => {
    const r = writer.pin("does-not-exist");
    expect(r.applied).toBe(false);
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe("unknown_decision");
  });
});
