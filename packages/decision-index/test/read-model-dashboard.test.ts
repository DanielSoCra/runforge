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
import { ReadModel } from "../src/read-model.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";

const NOW = "2026-05-27T03:00:00.000Z";

function classification(overrides: Record<string, string> = {}): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) m[p] = "internal";
  return { ...m, ...overrides };
}

interface ReqOverrides {
  risk_class?: string;
  deployment?: string;
  resume_mode?: "mid_run" | "requeue";
  created_at?: string;
  expires_at?: string;
  classification?: Record<string, string>;
  question?: string;
  context?: string;
  reversibility?: string;
}

function rawRequest(id: string, o: ReqOverrides = {}): unknown {
  return {
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
    recommended_option: "yes",
    consequence_of_no_answer: "paused",
    reversibility: o.reversibility ?? "reversible",
    expires_at: o.expires_at ?? "2026-06-01T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: o.resume_mode ?? "mid_run",
    idempotency_key: `idem-${id}`,
    field_sensitivity: o.classification ?? classification(),
  };
}

describe("ReadModel dashboard surface (listRanked / detail) — slice 4", () => {
  let t: TempDb;
  let protectedDir: string;
  let writer: IndexWriter;
  let reader: ReadModel;

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
    reader = writer.reader;
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  async function notify(id: string, o: ReqOverrides = {}): Promise<string> {
    const { decision_id } = writer.admit(rawRequest(id, o));
    await writer.runEffect(decision_id, "notify");
    return decision_id;
  }

  it("backward-compatible: get/list/audit still work", async () => {
    const id = await notify("01HRMDASH00000000000000A1");
    expect(reader.get(id)!.decision_id).toBe(id);
    expect(reader.list().some((d) => d.decision_id === id)).toBe(true);
    expect(Array.isArray(reader.audit(id))).toBe(true);
  });

  it("listRanked orders by priority score (P0 before P1 before P3) with why_ranked", async () => {
    await notify("01HRMDASH0000000000000P3X", { risk_class: "P3" });
    await notify("01HRMDASH0000000000000P0X", { risk_class: "P0" });
    await notify("01HRMDASH0000000000000P1X", { risk_class: "P1" });
    const ranked = reader.listRanked({ focus: { now: new Date(NOW) } });
    const ids = ranked.map((r) => r.decision_id);
    expect(ids.indexOf("01HRMDASH0000000000000P0X")).toBeLessThan(ids.indexOf("01HRMDASH0000000000000P1X"));
    expect(ids.indexOf("01HRMDASH0000000000000P1X")).toBeLessThan(ids.indexOf("01HRMDASH0000000000000P3X"));
    for (const r of ranked) {
      expect(typeof r.why_ranked).toBe("string");
      expect(r.why_ranked.length).toBeGreaterThan(0);
      expect(typeof r.score).toBe("number");
    }
  });

  it("list metadata for a PHI field carries {field, class} and NO ref", async () => {
    const id = await notify("01HRMDASH0000000000000PHI", {
      question: "Patient John Doe SSN 123-45-6789?",
      classification: classification({ question: "phi" }),
    });
    const ranked = reader.listRanked({ focus: { now: new Date(NOW) } });
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
    // the raw PHI plaintext must NEVER appear in the list payload
    expect(JSON.stringify(row)).not.toContain("John Doe");
    expect(JSON.stringify(row)).not.toContain("123-45-6789");
  });

  it("detail returns the {ref, class} token for a PHI field (no plaintext) and text for the rest", async () => {
    const id = await notify("01HRMDASH0000000000000DET", {
      question: "Patient John Doe SSN 123-45-6789?",
      context: "non-sensitive context",
      classification: classification({ question: "phi" }),
    });
    const detail = reader.detail(id)!;
    expect(detail.decision_id).toBe(id);
    expect(detail.question.kind).toBe("protected");
    if (detail.question.kind === "protected") {
      expect(detail.question.class).toBe("phi");
      expect(detail.question.field).toBe("question");
      // detail carries the ref (consumed by the server-only resolver)
      expect(detail.question.ref.startsWith("protected://")).toBe(true);
    }
    expect(detail.context.kind).toBe("text");
    if (detail.context.kind === "text") expect(detail.context.value).toBe("non-sensitive context");
    // still no plaintext PHI in the detail payload
    expect(JSON.stringify(detail)).not.toContain("John Doe");
    // detail exposes the full DecisionRequest fields
    expect(detail.reversibility).toBe("reversible");
    expect(detail.options.length).toBe(2);
    expect(detail.recommended_option).toBe("yes");
    expect(detail.resume_mode).toBe("mid_run");
  });

  it("detail option labels are protected tokens when classified phi", async () => {
    const id = await notify("01HRMDASH0000000000000OPT", {
      classification: classification({ "options[].label": "phi" }),
    });
    const detail = reader.detail(id)!;
    expect(detail.options[0]!.label.kind).toBe("protected");
    if (detail.options[0]!.label.kind === "protected") {
      expect(detail.options[0]!.label.ref.startsWith("protected://")).toBe(true);
      expect(detail.options[0]!.label.class).toBe("phi");
    }
    // the list also redacts option labels to {field, class} with no ref
    const ranked = reader.listRanked({ focus: { now: new Date(NOW) } });
    const row = ranked.find((r) => r.decision_id === id)!;
    expect(row.options[0]!.label.kind).toBe("protected");
    if (row.options[0]!.label.kind === "protected") {
      expect((row.options[0]!.label as Record<string, unknown>).ref).toBeUndefined();
    }
  });

  it("filters by status / risk / deployment", async () => {
    await notify("01HRMDASH0000000000000F0A", { risk_class: "P0", deployment: "alpha" });
    await notify("01HRMDASH0000000000000F1B", { risk_class: "P1", deployment: "beta" });
    expect(reader.listRanked({ filters: { risk_class: ["P0"] }, focus: { now: new Date(NOW) } }).map((r) => r.decision_id)).toEqual(["01HRMDASH0000000000000F0A"]);
    expect(reader.listRanked({ filters: { deployment: ["beta"] }, focus: { now: new Date(NOW) } }).map((r) => r.decision_id)).toEqual(["01HRMDASH0000000000000F1B"]);
    expect(reader.listRanked({ filters: { status: ["notified"] }, focus: { now: new Date(NOW) } }).length).toBe(2);
    expect(reader.listRanked({ filters: { status: ["resumed"] }, focus: { now: new Date(NOW) } }).length).toBe(0);
  });

  it("includeSuppressed honors muted / deferred (suppressed by default)", async () => {
    const muted = await notify("01HRMDASH0000000000000SUP");
    writer.mute(muted);
    const active = reader.listRanked({ focus: { now: new Date(NOW) } });
    expect(active.some((r) => r.decision_id === muted)).toBe(false);
    const all = reader.listRanked({ includeSuppressed: true, focus: { now: new Date(NOW) } });
    expect(all.some((r) => r.decision_id === muted)).toBe(true);
    const sup = all.find((r) => r.decision_id === muted)!;
    expect(sup.suppressed).toBe(true);
  });

  it("listRanked surfaces view-state + lifecycle fields (pinned/muted/deferred_until/source_url/resume_mode/status)", async () => {
    const id = await notify("01HRMDASH0000000000000VST", { resume_mode: "requeue" });
    writer.pin(id);
    const row = reader.listRanked({ focus: { now: new Date(NOW) } }).find((r) => r.decision_id === id)!;
    expect(row.pinned).toBe(true);
    expect(row.muted).toBe(false);
    expect(row.status).toBe("notified");
    expect(row.resume_mode).toBe("requeue");
    expect(row.source_url).toContain("example.test");
    expect(row.risk_class).toBe("P1");
  });

  it("detail returns undefined for an unknown id", () => {
    expect(reader.detail("nope")).toBeUndefined();
  });
});
