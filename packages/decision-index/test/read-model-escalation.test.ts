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
import { ReadModel } from "../src/read-model.js";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";
import { decisions } from "../src/schema.js";

const NOW = "2026-06-11T12:00:00.000Z";

function rawRequest(id: string, deployment: string): unknown {
  return {
    decision_id: id,
    protocol_version: PROTOCOL_VERSION,
    source_url: `https://example.test/issues/${id}`,
    source_etag: "etag-1",
    source_event_id: "evt-1",
    deployment,
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
    risk_class: "P1",
    question: "Proceed?",
    context: "ctx",
    options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    consequence_of_no_answer: "paused",
    reversibility: "reversible",
    expires_at: "2026-06-30T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: "mid_run",
    idempotency_key: `idem-${id}`,
  };
}

describe("ReadModel escalation counts (countCreatedSince / countAnsweredSince)", () => {
  let t: PgliteTestDb;
  let protectedDir: string;
  let writer: IndexWriter;
  let reader: ReadModel;

  beforeEach(async () => {
    t = await makePgliteDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-esc-"));
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
    reader = writer.reader;
  });

  afterEach(async () => {
    await t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  async function seedCreatedAt(decisionId: string, createdAt: string) {
    await t.db.update(decisions).set({ created_at: createdAt }).where(eq(decisions.decision_id, decisionId));
  }

  async function raiseAndAnswer(id: string, deployment: string, createdAt: string, answeredAt: string) {
    const { decision_id } = await writer.admit(rawRequest(id, deployment));
    await seedCreatedAt(decision_id, createdAt);
    await writer.runEffect(decision_id, "notify");
    await writer.applyEvent(decision_id, "answer_submitted", {
      actor: "operator",
      semanticKey: `${decision_id}:answer`,
      now: answeredAt,
      answer: {
        response_idempotency_key: `${decision_id}:answer`,
        chosen_option: "yes",
        answerer: "operator",
        answered_at: answeredAt,
      },
    });
    return decision_id;
  }

  it("counts raised decisions per week and deployment", async () => {
    const id1 = (await writer.admit(rawRequest("01HRMESC01", "alpha"))).decision_id;
    await seedCreatedAt(id1, "2026-06-02T10:00:00.000Z");
    const id2 = (await writer.admit(rawRequest("01HRMESC02", "alpha"))).decision_id;
    await seedCreatedAt(id2, "2026-06-03T10:00:00.000Z");
    const id3 = (await writer.admit(rawRequest("01HRMESC03", "beta"))).decision_id;
    await seedCreatedAt(id3, "2026-06-04T10:00:00.000Z");
    const id4 = (await writer.admit(rawRequest("01HRMESC04", "alpha"))).decision_id;
    await seedCreatedAt(id4, "2026-06-10T10:00:00.000Z");

    const created = await reader.countCreatedSince(undefined, "2026-06-01T00:00:00.000Z");
    const byKey = new Map(created.map((b) => [`${b.weekStart}:${b.deployment}`, b.count]));
    expect(byKey.get("2026-06-01:alpha")).toBe(2);
    expect(byKey.get("2026-06-01:beta")).toBe(1);
    expect(byKey.get("2026-06-08:alpha")).toBe(1);
  });

  it("filters created counts by deployment", async () => {
    const id1 = (await writer.admit(rawRequest("01HRMESC05", "alpha"))).decision_id;
    await seedCreatedAt(id1, "2026-06-02T10:00:00.000Z");
    const id2 = (await writer.admit(rawRequest("01HRMESC06", "beta"))).decision_id;
    await seedCreatedAt(id2, "2026-06-03T10:00:00.000Z");

    const alpha = await reader.countCreatedSince("alpha", "2026-06-01T00:00:00.000Z");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]).toMatchObject({ weekStart: "2026-06-01", deployment: "alpha", count: 1 });
  });

  it("counts answered decisions per week and deployment", async () => {
    await raiseAndAnswer("01HRMESC07", "alpha", "2026-06-02T10:00:00.000Z", "2026-06-05T12:00:00.000Z");
    await raiseAndAnswer("01HRMESC08", "beta", "2026-06-03T10:00:00.000Z", "2026-06-06T12:00:00.000Z");
    await raiseAndAnswer("01HRMESC09", "beta", "2026-06-09T10:00:00.000Z", "2026-06-12T12:00:00.000Z");

    const answered = await reader.countAnsweredSince(undefined, "2026-06-01T00:00:00.000Z");
    const byKey = new Map(answered.map((b) => [`${b.weekStart}:${b.deployment}`, b.count]));
    expect(byKey.get("2026-06-01:alpha")).toBe(1);
    expect(byKey.get("2026-06-01:beta")).toBe(1);
    expect(byKey.get("2026-06-08:beta")).toBe(1);
  });

  it("filters answered counts by deployment", async () => {
    await raiseAndAnswer("01HRMESC10", "alpha", "2026-06-02T10:00:00.000Z", "2026-06-05T12:00:00.000Z");
    await raiseAndAnswer("01HRMESC11", "beta", "2026-06-03T10:00:00.000Z", "2026-06-06T12:00:00.000Z");

    const alpha = await reader.countAnsweredSince("alpha", "2026-06-01T00:00:00.000Z");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]).toMatchObject({ weekStart: "2026-06-01", deployment: "alpha", count: 1 });
  });

  it("honors the since boundary", async () => {
    const id1 = (await writer.admit(rawRequest("01HRMESC12", "alpha"))).decision_id;
    await seedCreatedAt(id1, "2026-05-25T10:00:00.000Z");
    const id2 = (await writer.admit(rawRequest("01HRMESC13", "alpha"))).decision_id;
    await seedCreatedAt(id2, "2026-06-02T10:00:00.000Z");

    const created = await reader.countCreatedSince("alpha", "2026-06-01T00:00:00.000Z");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ weekStart: "2026-06-01", deployment: "alpha", count: 1 });
  });
});
