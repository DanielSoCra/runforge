import { eq } from "drizzle-orm";
import type { ItemStatus, SensitivityClass, Reversibility } from "@auto-claude/decision-protocol";
import type { Db } from "./db.js";
import { decisions, auditLog, decisionResponses, protectedRefs } from "./schema.js";
import { score, type FocusContext } from "./priority.js";

export interface DecisionView {
  decision_id: string;
  status: ItemStatus;
  stale: boolean;
  risk_class: string;
  run_id: string;
  /** how a resolved item resumes its worker (drives requeue vs mid_run wake). */
  resume_mode: "mid_run" | "requeue";
  source_url: string;
  superseded_by: string | null;
  trace_id: string | null;
  agent_version: string | null;
  skill_version: string | null;
  source_event_id: string | null;
  last_notified_at: string | null;
}

export interface AuditView {
  from: string | null;
  to: string | null;
  event: string;
  transition_key: string | null;
  at: string;
}

/**
 * Slice-4 redaction-typed field shapes. A `protected` field NEVER carries
 * plaintext. The LIST surface omits the resolvable `ref` (class only, for a
 * placeholder); only DETAIL carries the `ref`, consumed by the server-only
 * resolver. The discriminated `kind` makes the redaction boundary type-enforced.
 */
export type ListField =
  | { kind: "text"; value: string }
  | { kind: "protected"; field: string; class: SensitivityClass };

export type DetailField =
  | { kind: "text"; value: string }
  | { kind: "protected"; field: string; class: SensitivityClass; ref: string };

export interface ListOption {
  id: string;
  label: ListField;
  detail?: ListField;
}
export interface DetailOption {
  id: string;
  label: DetailField;
  detail?: DetailField;
}

/** A ranked inbox row (no resolvable PHI ref — class only on protected fields). */
export interface RankedListItem {
  decision_id: string;
  status: ItemStatus;
  risk_class: string;
  deployment: string;
  source_url: string;
  resume_mode: "mid_run" | "requeue";
  reversibility: Reversibility | null;
  pinned: boolean;
  muted: boolean;
  deferred_until: string | null;
  stale: boolean;
  expires_at: string | null;
  created_at: string;
  last_notified_at: string | null;
  recommended_option: string | null;
  question: ListField;
  context: ListField | null;
  consequence_of_no_answer: ListField | null;
  options: ListOption[];
  // priority projection (slice-1 priority.score + why_ranked)
  score: number;
  why_ranked: string;
  suppressed: boolean;
}

/** A per-item detail view (carries the resolvable refs for the server-only resolver). */
export interface DetailView {
  decision_id: string;
  status: ItemStatus;
  risk_class: string;
  deployment: string;
  source_url: string;
  source_etag: string | null;
  resume_mode: "mid_run" | "requeue";
  reversibility: Reversibility | null;
  pinned: boolean;
  muted: boolean;
  deferred_until: string | null;
  stale: boolean;
  superseded_by: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_notified_at: string | null;
  recommended_option: string | null;
  answer_schema: unknown;
  question: DetailField;
  context: DetailField | null;
  consequence_of_no_answer: DetailField | null;
  options: DetailOption[];
}

export interface ListFilters {
  status?: string[];
  risk_class?: string[];
  deployment?: string[];
}

export interface ListRankedArgs {
  filters?: ListFilters;
  focus?: FocusContext;
  /** include muted/deferred items (default false — active ranking only). */
  includeSuppressed?: boolean;
}

const PROTECTED_PREFIX = "protected://";

/** Read-only projection over the index. Non-writer callers get only this. */
export class ReadModel {
  constructor(private readonly db: Db) {}

  get(decisionId: string): DecisionView | undefined {
    const r = this.db
      .select()
      .from(decisions)
      .where(eq(decisions.decision_id, decisionId))
      .all()[0];
    if (!r) return undefined;
    return {
      decision_id: r.decision_id,
      status: r.status as ItemStatus,
      stale: r.stale,
      risk_class: r.risk_class,
      run_id: r.run_id,
      resume_mode: r.resume_mode as "mid_run" | "requeue",
      source_url: r.source_url,
      superseded_by: r.superseded_by,
      trace_id: r.trace_id,
      agent_version: r.agent_version,
      skill_version: r.skill_version,
      source_event_id: r.source_event_id,
      last_notified_at: r.last_notified_at,
    };
  }

  audit(decisionId: string): AuditView[] {
    return this.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision_id === decisionId)
      .map((a) => ({
        from: a.from_status,
        to: a.to_status,
        event: a.event,
        transition_key: a.transition_key,
        at: a.at,
      }));
  }

  hasResponse(decisionId: string): boolean {
    return (
      this.db
        .select()
        .from(decisionResponses)
        .where(eq(decisionResponses.decision_id, decisionId))
        .all().length > 0
    );
  }

  list(): DecisionView[] {
    return this.db
      .select()
      .from(decisions)
      .all()
      .map((r) => ({
        decision_id: r.decision_id,
        status: r.status as ItemStatus,
        stale: r.stale,
        risk_class: r.risk_class,
        run_id: r.run_id,
        resume_mode: r.resume_mode as "mid_run" | "requeue",
        source_url: r.source_url,
        superseded_by: r.superseded_by,
        trace_id: r.trace_id,
        agent_version: r.agent_version,
        skill_version: r.skill_version,
        source_event_id: r.source_event_id,
        last_notified_at: r.last_notified_at,
      }));
  }

  // ── slice-4 dashboard surface (ADDITIONS; the methods above stay unchanged) ──

  /** Map a ulid -> its protected_refs class for a single decision. */
  private protectedClasses(decisionId: string): Map<string, SensitivityClass> {
    const m = new Map<string, SensitivityClass>();
    for (const ref of this.db
      .select()
      .from(protectedRefs)
      .where(eq(protectedRefs.decision_id, decisionId))
      .all()) {
      m.set(ref.ulid, ref.class as SensitivityClass);
    }
    return m;
  }

  /** Resolve a stored column value to a LIST field (class only, no ref). */
  private listField(field: string, value: string, classes: Map<string, SensitivityClass>): ListField {
    if (value.startsWith(PROTECTED_PREFIX)) {
      const ulid = value.slice(PROTECTED_PREFIX.length);
      return { kind: "protected", field, class: classes.get(ulid) ?? ("secret" as SensitivityClass) };
    }
    return { kind: "text", value };
  }

  /** Resolve a stored column value to a DETAIL field (carries the resolvable ref). */
  private detailField(field: string, value: string, classes: Map<string, SensitivityClass>): DetailField {
    if (value.startsWith(PROTECTED_PREFIX)) {
      const ulid = value.slice(PROTECTED_PREFIX.length);
      return {
        kind: "protected",
        field,
        class: classes.get(ulid) ?? ("secret" as SensitivityClass),
        ref: value,
      };
    }
    return { kind: "text", value };
  }

  /**
   * Ranked dashboard inbox (slice 4). Rows ordered by the slice-1 priority.score
   * with `why_ranked`. Protected fields carry {field, class} ONLY (no resolvable
   * ref). Suppressed (muted/deferred) items are dropped unless `includeSuppressed`.
   */
  listRanked(args: ListRankedArgs = {}): RankedListItem[] {
    const focus: FocusContext = args.focus ?? { now: new Date() };
    const rows = this.db.select().from(decisions).all();

    const items: RankedListItem[] = [];
    for (const r of rows) {
      if (args.filters?.status && !args.filters.status.includes(r.status)) continue;
      if (args.filters?.risk_class && !args.filters.risk_class.includes(r.risk_class)) continue;
      if (args.filters?.deployment && !args.filters.deployment.includes(r.deployment)) continue;

      const priority = score(
        {
          decision_id: r.decision_id,
          risk_class: r.risk_class,
          created_at: r.created_at,
          expires_at: r.expires_at,
          deployment: r.deployment,
          pinned: r.pinned,
          muted: r.muted,
          deferred_until: r.deferred_until,
          stale: r.stale,
        },
        focus,
      );
      if (priority.suppressed && !args.includeSuppressed) continue;

      const classes = this.protectedClasses(r.decision_id);
      const options = (JSON.parse(r.options_json) as { id: string; label: string; detail?: string }[]).map(
        (o, idx): ListOption => ({
          id: o.id,
          label: this.listField(`options[${idx}].label`, o.label, classes),
          ...(o.detail !== undefined
            ? { detail: this.listField(`options[${idx}].detail`, o.detail, classes) }
            : {}),
        }),
      );

      items.push({
        decision_id: r.decision_id,
        status: r.status as ItemStatus,
        risk_class: r.risk_class,
        deployment: r.deployment,
        source_url: r.source_url,
        resume_mode: r.resume_mode as "mid_run" | "requeue",
        reversibility: (r.reversibility as Reversibility | null) ?? null,
        pinned: r.pinned,
        muted: r.muted,
        deferred_until: r.deferred_until,
        stale: r.stale,
        expires_at: r.expires_at,
        created_at: r.created_at,
        last_notified_at: r.last_notified_at,
        recommended_option: r.recommended_option,
        question: this.listField("question", r.question, classes),
        context: r.context != null ? this.listField("context", r.context, classes) : null,
        consequence_of_no_answer:
          r.consequence_of_no_answer != null
            ? this.listField("consequence_of_no_answer", r.consequence_of_no_answer, classes)
            : null,
        options,
        score: priority.score,
        why_ranked: priority.why_ranked,
        suppressed: priority.suppressed,
      });
    }

    // Deterministic order: score desc, decision_id asc tie-break (matches priority.rank).
    items.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.decision_id < b.decision_id ? -1 : 1));
    return items;
  }

  /**
   * Full DecisionRequest detail (slice 4). Protected fields carry {ref, class}
   * tokens — the `ref` appears ONLY here, consumed by the server-only resolver in
   * the authenticated detail render. No plaintext.
   */
  detail(decisionId: string): DetailView | undefined {
    const r = this.db.select().from(decisions).where(eq(decisions.decision_id, decisionId)).all()[0];
    if (!r) return undefined;
    const classes = this.protectedClasses(decisionId);
    const options = (JSON.parse(r.options_json) as { id: string; label: string; detail?: string }[]).map(
      (o, idx): DetailOption => ({
        id: o.id,
        label: this.detailField(`options[${idx}].label`, o.label, classes),
        ...(o.detail !== undefined
          ? { detail: this.detailField(`options[${idx}].detail`, o.detail, classes) }
          : {}),
      }),
    );
    return {
      decision_id: r.decision_id,
      status: r.status as ItemStatus,
      risk_class: r.risk_class,
      deployment: r.deployment,
      source_url: r.source_url,
      source_etag: r.source_etag,
      resume_mode: r.resume_mode as "mid_run" | "requeue",
      reversibility: (r.reversibility as Reversibility | null) ?? null,
      pinned: r.pinned,
      muted: r.muted,
      deferred_until: r.deferred_until,
      stale: r.stale,
      superseded_by: r.superseded_by,
      expires_at: r.expires_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      last_notified_at: r.last_notified_at,
      recommended_option: r.recommended_option,
      answer_schema: JSON.parse(r.answer_schema_json),
      question: this.detailField("question", r.question, classes),
      context: r.context != null ? this.detailField("context", r.context, classes) : null,
      consequence_of_no_answer:
        r.consequence_of_no_answer != null
          ? this.detailField("consequence_of_no_answer", r.consequence_of_no_answer, classes)
          : null,
      options,
    };
  }
}
