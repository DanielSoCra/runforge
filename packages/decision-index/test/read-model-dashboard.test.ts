import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { ReadModel } from "../src/read-model.js";
import { PROTOCOL_VERSION } from "@auto-claude/decision-protocol";
import { eq } from "drizzle-orm";
import { decisions, protectedRefs } from "../src/schema.js";

const NOW = "2026-05-27T03:00:00.000Z";

interface ReqOverrides {
  risk_class?: string;
  deployment?: string;
  resume_mode?: "mid_run" | "requeue";
  created_at?: string;
  expires_at?: string;
  question?: string;
  context?: string;
  reversibility?: string;
  /** `null` explicitly omits recommended_option; a string overrides it (default "yes"). */
  recommendedOption?: string | null;
}

function rawRequest(id: string, o: ReqOverrides = {}): unknown {
  const base: Record<string, unknown> = {
    decision_id: id,
    protocol_version: PROTOCOL_VERSION,
    source_url: `https://example.test/issues/${id}`,
    source_etag: "etag-1",
    source_event_id: "evt-1",
    deployment: o.deployment ?? "dep",
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
    risk_class: o.risk_class ?? "P1",
    question: o.question ?? "Proceed?",
    context: o.context ?? "ctx",
    options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    consequence_of_no_answer: "paused",
    reversibility: o.reversibility ?? "reversible",
    expires_at: o.expires_at ?? "2026-06-01T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: o.resume_mode ?? "mid_run",
    idempotency_key: `idem-${id}`,
  };
  // `null` explicitly omits recommended_option (schema field is optional); a string
  // overrides; default "yes" (backward-compatible with the prior fixed value).
  if (o.recommendedOption !== null) {
    base.recommended_option = o.recommendedOption ?? "yes";
  }
  return base;
}

/** Seed a legacy protected:// row by mutating the admitted decisions row directly. */
async function seedProtectedQuestion(
  db: PgliteTestDb["db"],
  decisionId: string,
  ulid: string,
  cls: string,
) {
  await db.insert(protectedRefs)
    .values({
      ulid,
      decision_id: decisionId,
      field: "question",
      class: cls,
      created_at: NOW,
    });
  await db.update(decisions)
    .set({ question: `protected://${ulid}` })
    .where(eq(decisions.decision_id, decisionId));
}

async function seedProtectedOptionLabel(
  db: PgliteTestDb["db"],
  decisionId: string,
  ulid: string,
  cls: string,
) {
  await db.insert(protectedRefs)
    .values({
      ulid,
      decision_id: decisionId,
      field: "options[0].label",
      class: cls,
      created_at: NOW,
    });
  const row = (await db.select().from(decisions).where(eq(decisions.decision_id, decisionId)))[0]!;
  const options = JSON.parse(row.options_json);
  options[0].label = `protected://${ulid}`;
  await db.update(decisions)
    .set({ options_json: JSON.stringify(options) })
    .where(eq(decisions.decision_id, decisionId));
}

describe("ReadModel dashboard surface (listRanked / detail) — slice 4", () => {
  let t: PgliteTestDb;
  let protectedDir: string;
  let writer: IndexWriter;
  let reader: ReadModel;

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
    reader = writer.reader;
  });
  afterEach(async () => {
    await t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  async function notify(id: string, o: ReqOverrides = {}): Promise<string> {
    const { decision_id } = await writer.admit(rawRequest(id, o));
    await writer.runEffect(decision_id, "notify");
    return decision_id;
  }

  it("backward-compatible: get/list/audit still work", async () => {
    const id = await notify("01HRMDASH00000000000000A1");
    expect((await reader.get(id))!.decision_id).toBe(id);
    expect((await reader.list()).some((d) => d.decision_id === id)).toBe(true);
    expect(Array.isArray(await reader.audit(id))).toBe(true);
  });

  it("listRanked orders by priority score (P0 before P1 before P3) with why_ranked", async () => {
    await notify("01HRMDASH0000000000000P3X", { risk_class: "P3" });
    await notify("01HRMDASH0000000000000P0X", { risk_class: "P0" });
    await notify("01HRMDASH0000000000000P1X", { risk_class: "P1" });
    const ranked = await reader.listRanked({ focus: { now: new Date(NOW) } });
    const ids = ranked.map((r) => r.decision_id);
    expect(ids.indexOf("01HRMDASH0000000000000P0X")).toBeLessThan(ids.indexOf("01HRMDASH0000000000000P1X"));
    expect(ids.indexOf("01HRMDASH0000000000000P1X")).toBeLessThan(ids.indexOf("01HRMDASH0000000000000P3X"));
    for (const r of ranked) {
      expect(typeof r.why_ranked).toBe("string");
      expect(r.why_ranked.length).toBeGreaterThan(0);
      expect(typeof r.score).toBe("number");
    }
  });

  it("list metadata for a legacy protected:// field carries {field, class} and NO ref", async () => {
    const id = await notify("01HRMDASH0000000000000PHI", {
      question: "will-be-replaced-by-protected-ref",
    });
    await seedProtectedQuestion(t.db, id, "01HLEGACYQUESTION0000000001", "phi");
    const ranked = await reader.listRanked({ focus: { now: new Date(NOW) } });
    const row = ranked.find((r) => r.decision_id === id)!;
    expect(row.question.kind).toBe("protected");
    if (row.question.kind === "protected") {
      expect(row.question.class).toBe("phi");
      expect(row.question.field).toBe("question");
      // CRITICAL: the list surface must NOT carry a resolvable ref.
      expect((row.question as Record<string, unknown>).ref).toBeUndefined();
    }
    // a non-protected field is plain text
    expect(row.context.kind).toBe("text");
  });

  it("detail returns the {ref, class} token for a legacy protected:// field (no plaintext)", async () => {
    const id = await notify("01HRMDASH0000000000000DET", {
      question: "will-be-replaced-by-protected-ref",
      context: "non-sensitive context",
    });
    await seedProtectedQuestion(t.db, id, "01HLEGACYQUESTION0000000002", "phi");
    const detail = (await reader.detail(id))!;
    expect(detail.decision_id).toBe(id);
    expect(detail.question.kind).toBe("protected");
    if (detail.question.kind === "protected") {
      expect(detail.question.class).toBe("phi");
      expect(detail.question.field).toBe("question");
      // detail carries the ref (consumed by the server-only resolver)
      expect(detail.question.ref).toBe("protected://01HLEGACYQUESTION0000000002");
    }
    expect(detail.context.kind).toBe("text");
    if (detail.context.kind === "text") expect(detail.context.value).toBe("non-sensitive context");
    // detail exposes the full DecisionRequest fields
    expect(detail.reversibility).toBe("reversible");
    expect(detail.options.length).toBe(2);
    expect(detail.recommended_option).toBe("yes");
    expect(detail.resume_mode).toBe("mid_run");
  });

  it("detail option labels are protected tokens for legacy protected:// rows", async () => {
    const id = await notify("01HRMDASH0000000000000OPT");
    await seedProtectedOptionLabel(t.db, id, "01HLEGACYOPTIONLABEL00000001", "phi");
    const detail = (await reader.detail(id))!;
    expect(detail.options[0]!.label.kind).toBe("protected");
    if (detail.options[0]!.label.kind === "protected") {
      expect(detail.options[0]!.label.ref).toBe("protected://01HLEGACYOPTIONLABEL00000001");
      expect(detail.options[0]!.label.class).toBe("phi");
    }
    // the list also redacts option labels to {field, class} with no ref
    const ranked = await reader.listRanked({ focus: { now: new Date(NOW) } });
    const row = ranked.find((r) => r.decision_id === id)!;
    expect(row.options[0]!.label.kind).toBe("protected");
    if (row.options[0]!.label.kind === "protected") {
      expect((row.options[0]!.label as Record<string, unknown>).ref).toBeUndefined();
    }
  });

  it("filters by status / risk / deployment", async () => {
    await notify("01HRMDASH0000000000000F0A", { risk_class: "P0", deployment: "alpha" });
    await notify("01HRMDASH0000000000000F1B", { risk_class: "P1", deployment: "beta" });
    expect((await reader.listRanked({ filters: { risk_class: ["P0"] }, focus: { now: new Date(NOW) } })).map((r) => r.decision_id)).toEqual(["01HRMDASH0000000000000F0A"]);
    expect((await reader.listRanked({ filters: { deployment: ["beta"] }, focus: { now: new Date(NOW) } })).map((r) => r.decision_id)).toEqual(["01HRMDASH0000000000000F1B"]);
    expect((await reader.listRanked({ filters: { status: ["notified"] }, focus: { now: new Date(NOW) } })).length).toBe(2);
    expect((await reader.listRanked({ filters: { status: ["resumed"] }, focus: { now: new Date(NOW) } })).length).toBe(0);
  });

  it("includeSuppressed honors muted / deferred (suppressed by default)", async () => {
    const muted = await notify("01HRMDASH0000000000000SUP");
    await writer.mute(muted);
    const active = await reader.listRanked({ focus: { now: new Date(NOW) } });
    expect(active.some((r) => r.decision_id === muted)).toBe(false);
    const all = await reader.listRanked({ includeSuppressed: true, focus: { now: new Date(NOW) } });
    expect(all.some((r) => r.decision_id === muted)).toBe(true);
    const sup = all.find((r) => r.decision_id === muted)!;
    expect(sup.suppressed).toBe(true);
  });

  it("listRanked surfaces view-state + lifecycle fields (pinned/muted/deferred_until/source_url/resume_mode/status)", async () => {
    const id = await notify("01HRMDASH0000000000000VST", { resume_mode: "requeue" });
    await writer.pin(id);
    const row = (await reader.listRanked({ focus: { now: new Date(NOW) } })).find((r) => r.decision_id === id)!;
    expect(row.pinned).toBe(true);
    expect(row.muted).toBe(false);
    expect(row.status).toBe("notified");
    expect(row.resume_mode).toBe("requeue");
    expect(row.source_url).toContain("example.test");
    expect(row.risk_class).toBe("P1");
  });

  it("detail returns undefined for an unknown id", async () => {
    expect(await reader.detail("nope")).toBeUndefined();
  });

  describe("recommendedOptionOf (cheap scalar accessor)", () => {
    it("returns the stored recommended_option column value", async () => {
      const id = await notify("01HRMDASH0000000000000REC");
      // rawRequest seeds recommended_option: "yes".
      expect(await reader.recommendedOptionOf(id)).toBe("yes");
    });

    it("returns null when the column is null (no recommended_option)", async () => {
      const id = await notify("01HRMDASH0000000000000NUL", {
        recommendedOption: null,
      });
      expect(await reader.recommendedOptionOf(id)).toBeNull();
    });

    it("returns null for a missing row", async () => {
      expect(await reader.recommendedOptionOf("01HRMDASH00000MISSING000000")).toBeNull();
    });
  });
});
