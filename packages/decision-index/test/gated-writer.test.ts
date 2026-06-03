import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { openDb, openReadOnlyDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createIndexWriter } from "../src/index-writer.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION, SENSITIVITY_FIELD_PATHS } from "@auto-claude/decision-protocol";

const NOW = "2026-05-27T08:00:00.000Z";

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

describe("gated single writer (A7/I7)", () => {
  let dir: string;
  let dbPath: string;
  let protectedDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-gated-"));
    dbPath = join(dir, "pm.sqlite");
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-gated-"));
    // create + migrate the file once (writable) so the read-only open can attach.
    const w = openDb({ path: dbPath });
    migrate(w);
    w.$client.close();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(protectedDir, { recursive: true, force: true });
  });

  function deps() {
    return {
      dbPath,
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir,
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date(NOW),
      channel: "slack",
    };
  }

  it("createIndexWriter constructs a working writer that admits + drives to notified", async () => {
    const writer = createIndexWriter({ ...deps(), skipMigrate: true });
    const { decision_id } = writer.admit(rawRequest("01HGATED00000000000000001"));
    await writer.runEffect(decision_id, "notify");
    expect(writer.reader.get(decision_id)!.status).toBe("notified");
    writer.close();
  });

  it("openReadOnlyDb rejects writes at the SQLite layer", () => {
    const ro = openReadOnlyDb({ path: dbPath });
    expect(() =>
      ro.$client.prepare("INSERT INTO quarantine_events (reason, created_at) VALUES ('x','y')").run(),
    ).toThrow(/readonly|read-only/i);
    ro.$client.close();
  });

  it("a read-only db can still read what the writer committed", async () => {
    const writer = createIndexWriter({ ...deps(), skipMigrate: true });
    const { decision_id } = writer.admit(rawRequest("01HGATED00000000000000002"));
    await writer.runEffect(decision_id, "notify");
    writer.close();

    const ro = openReadOnlyDb({ path: dbPath });
    const rows = ro.$client.prepare("SELECT status FROM decisions WHERE decision_id = ?").all(
      "01HGATED00000000000000002",
    ) as { status: string }[];
    expect(rows[0]!.status).toBe("notified");
    ro.$client.close();
  });
});
