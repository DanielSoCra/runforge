import { PROTOCOL_VERSION } from "@runforge/decision-protocol";
import type { Db } from "../../src/db.js";
import { decisions } from "../../src/schema.js";
import type { DecisionRow } from "../../src/ingest.js";

export interface SeedOverrides {
  decision_id?: string;
  status?: string;
  resume_mode?: "mid_run" | "requeue";
  answer_schema_json?: string;
  options_json?: string;
  expires_at?: string | null;
}

/** Insert a minimal `detected` decision row for state-machine tests. */
export async function seedDecision(db: Db, o: SeedOverrides = {}): Promise<string> {
  const id = o.decision_id ?? `d-${Math.random().toString(36).slice(2, 10)}`;
  const now = "2026-05-27T00:00:00.000Z";
  const row: DecisionRow = {
    decision_id: id,
    protocol_version: PROTOCOL_VERSION,
    status: o.status ?? "detected",
    source_url: "https://example.test/1",
    source_etag: "etag-0",
    source_event_id: "evt-0",
    deployment: "dep",
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
    risk_class: "P1",
    question: "Proceed?",
    context: "ctx",
    options_json: o.options_json ?? JSON.stringify([{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]),
    recommended_option: "yes",
    consequence_of_no_answer: "paused",
    reversibility: "reversible",
    answer_schema_json: o.answer_schema_json ?? JSON.stringify({ kind: "option" }),
    resume_mode: o.resume_mode ?? "mid_run",
    idempotency_key: "idem-0",
    trace_id: "trace-0",
    agent_version: "1.0.0",
    skill_version: "0.1.0",
    expires_at: o.expires_at === undefined ? "2026-06-01T00:00:00.000Z" : o.expires_at,
    last_seen_at: now,
    last_notified_at: null,
    stale: false,
    superseded_by: null,
    pinned: false,
    muted: false,
    deferred_until: null,
    created_at: now,
    updated_at: now,
  };
  await db.insert(decisions).values(row);
  return id;
}
