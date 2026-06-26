import { randomUUID } from "node:crypto";
import {
  DecisionRequestSchema,
  TERMINAL_STATUSES,
  type ItemStatus,
  type TransitionEvent,
  type EffectKind,
} from "@auto-claude/decision-protocol";
import { eq } from "drizzle-orm";
import type { Db, Sql } from "./db.js";
import { withTx } from "./db.js";
import { decisions, workerSessions } from "./schema.js";
import { appendAudit, type WorkflowAuditEvent } from "./audit-log.js";
import { ingest, type IngestDeps, type DecisionRow } from "./ingest.js";
import type { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import type { Quarantine } from "./quarantine.js";
import { apply, type ApplyCtx, type ApplyResult } from "./state-machine.js";
import { Outbox, type RunEffectResult, type RunEffectOptions, type PendingEffect } from "./outbox.js";
import { ReadModel, type DetailField } from "./read-model.js";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { ProtectedStore as ProtectedStoreImpl } from "@auto-claude/sanitizer-redaction";
import { PgQuarantine } from "./quarantine.js";
import type { Notifier } from "./adapters/notifier.js";
import type { SourceSink } from "./adapters/source-sink.js";
import type { ResumeDispatcher } from "./adapters/resume-dispatcher.js";

/** Thrown when a reveal request references a protected ref that does not belong to the decision. */
export class RevealRefNotFoundError extends Error {
  constructor(decisionId: string, ref: string) {
    super(`reveal ref not found for decision ${decisionId}: ${ref}`);
    this.name = "RevealRefNotFoundError";
  }
}

export interface IndexWriterDeps {
  db: Db;
  /** raw writer client to `end()` on close (production); omitted in PGlite tests. */
  sql?: Sql;
  protectedStore: ProtectedStore;
  quarantine: Quarantine;
  notifier: Notifier;
  sourceSink: SourceSink;
  resumeDispatcher: ResumeDispatcher;
  clock: () => Date;
  channel?: string;
  maxAttempts?: number;
  /**
   * CRITICAL 1: this writer's per-process generation id (the outbox claim owner
   * token). Defaults to a fresh uuid per writer construction; reconcile never
   * reclaims an `executing` row owned by THIS generation, so a live slow adapter
   * call is never re-dispatched.
   */
  generation?: string;
}

/**
 * Construction deps for the gated factory (I7). The factory opens the single
 * WRITABLE connection internally (via the internal `openDb`) and constructs the
 * ProtectedStore + Quarantine over THAT SAME connection — so `openDb` need not
 * be on the package public surface and there is exactly one writable connection.
 * This is the ONLY supported way to obtain a writer through the package; readers
 * use `openReadOnlyDb()`.
 */
export interface CreateIndexWriterOptions {
  /** Postgres URL; the factory opens the writer connection + runs migrate(). */
  databaseUrl: string;
  /** base64 AES-256 key for the protected store. */
  protectedKey: string;
  /** directory for the protected blob store. */
  protectedDir: string;
  notifier: Notifier;
  sourceSink: SourceSink;
  resumeDispatcher: ResumeDispatcher;
  clock: () => Date;
  channel?: string;
  maxAttempts?: number;
  /** skip migrate() (the db is already migrated). Default: false (run migrate). */
  skipMigrate?: boolean;
  /**
   * CRITICAL 1: per-process generation id (outbox claim owner token). Defaults to
   * a fresh uuid minted at factory call (i.e. per writer construction / per
   * process). Tests inject a fixed value to model crash recovery across processes.
   */
  generation?: string;
}

/**
 * Gated single-writer factory (I7). Opens the ONE writable connection internally,
 * builds the ProtectedStore + Quarantine over it, and returns an IndexWriter. The
 * package public surface exposes only this + `openReadOnlyDb()`; raw `openDb` is
 * internal, so the single-writer invariant is enforced by the SURFACE.
 */
export async function createIndexWriter(opts: CreateIndexWriterOptions): Promise<IndexWriter> {
  const { db, sql } = await openDb({ url: opts.databaseUrl });
  // HANDLE-LEAK FIX (verdict fix_before_flag_on / index-writer.ts:84): openDb()
  // has already acquired the writer connection. If migrate() or the ProtectedStore
  // ctor (e.g. a bad-length protectedKey) throws, the connection would leak — the
  // caller catches higher up but never sees `db`. End `sql` before rethrowing so a
  // broken-config boot path frees the connection.
  try {
    if (!opts.skipMigrate) await migrate(db);
    const protectedStore = new ProtectedStoreImpl({
      key: opts.protectedKey,
      dir: opts.protectedDir,
      db,
      // Inject the guarded writer primitive so the protected_refs pointer insert
      // acquires the writer mutex + per-tx advisory lock (and re-uses an open
      // writer tx when nested). Bound to THIS writer's db (spec §3.5a/§3.10).
      runWrite: (fn) => withTx(db, fn),
    });
    const quarantine = new PgQuarantine(db);
    return new IndexWriter({
      db,
      sql,
      protectedStore,
      quarantine,
      notifier: opts.notifier,
      sourceSink: opts.sourceSink,
      resumeDispatcher: opts.resumeDispatcher,
      clock: opts.clock,
      channel: opts.channel,
      maxAttempts: opts.maxAttempts,
      // CRITICAL 1: mint the per-process generation here so every IndexWriter built
      // by the factory has a stable owner token for the life of the process.
      generation: opts.generation ?? randomUUID(),
    });
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
}

export interface WorkerSessionMeta {
  worker_session_id?: string;
  wake_command?: string;
  requeue_command?: string;
  work_request_ref?: string;
  transcript_path?: string;
}

/** Options for the guarded view-state ops (slice 4). */
export interface WorkflowOpOptions {
  actor?: string;
  now?: string;
}

/**
 * Result of a guarded view-state op. `applied=false` is a guarded no-op (the item
 * is terminal/superseded/in-flight/unknown — the `reason` says which); no mutation
 * and no audit row were written in that case.
 */
export interface WorkflowOpResult {
  applied: boolean;
  status: ItemStatus | "unknown";
  reason?: "unknown_decision" | "not_view_state";
}

/**
 * The single-writer facade (spec §70) — the ONLY write path into the index.
 * Non-writer callers receive `reader` (a read-only projection); the write
 * internals (ingest/apply/outbox/raw SQLite) are NOT exported from the package
 * surface, so the single-writer invariant holds structurally.
 */
export class IndexWriter {
  private readonly db: Db;
  private readonly sql: Sql | undefined;
  private readonly ingestDeps: IngestDeps;
  private readonly outbox: Outbox;
  private readonly clock: () => Date;
  readonly protectedStore: ProtectedStore;
  readonly reader: ReadModel;
  /** the content-free quarantine sink over the SINGLE writable connection, so a
   * GitHub-layer pre-ingest rejection (PHI policy / malformed block) records
   * through the same writer (no second writable connection). */
  readonly quarantine: Quarantine;

  constructor(deps: IndexWriterDeps) {
    this.db = deps.db;
    this.sql = deps.sql;
    this.clock = deps.clock;
    this.protectedStore = deps.protectedStore;
    this.quarantine = deps.quarantine;
    this.ingestDeps = {
      db: deps.db,
      quarantine: deps.quarantine,
      clock: deps.clock,
    };
    this.outbox = new Outbox({
      db: deps.db,
      notifier: deps.notifier,
      sourceSink: deps.sourceSink,
      resumeDispatcher: deps.resumeDispatcher,
      clock: deps.clock,
      channel: deps.channel,
      maxAttempts: deps.maxAttempts,
      generation: deps.generation,
    });
    this.reader = new ReadModel(deps.db);
  }

  /** Fail-closed admit: ingest (classify+redact) then insert the `detected` row. */
  async admit(rawRequest: unknown): Promise<{ decision_id: string }> {
    const { decisionRow }: { decisionRow: DecisionRow } = await ingest(rawRequest, this.ingestDeps);
    await withTx(this.db, async (tx) => {
      await tx.insert(decisions).values(decisionRow);
    });
    return { decision_id: decisionRow.decision_id };
  }

  /**
   * Idempotent observe (I6) — the poller's single durable entry point. A
   * DecisionRequest is IMMUTABLE per `decision_id`:
   *   - new decision_id                  -> admit (fail-closed ingest).
   *   - same id + same source_etag       -> bump last_seen_at, no-op.
   *   - same id + DIFFERENT source_etag  -> the request block was edited under an
   *     in-flight decision (an anomaly): SUPERSEDE the existing item (terminal,
   *     content-free) — changed content re-enters only under a NEW decision_id.
   *     A5/I6: supersede is legal from ANY non-terminal status (incl. `detected`
   *     before the notify effect runs); a terminal item is left settled.
   *
   * The locator/etag are read from the RAW (operational, never-redacted) request
   * so no protected lookup is needed.
   */
  async observeRequest(
    rawRequest: unknown,
    sourceObservedAt?: string,
  ): Promise<{ decision_id: string; outcome: "admitted" | "unchanged" | "superseded" }> {
    const now = sourceObservedAt ?? this.clock().toISOString();
    // Operational fields (decision_id, source_etag, source_url) are never
    // redacted, so a light schema parse is enough to read them for dedup. A parse
    // failure is a fail-closed admit (quarantines content-free), surfaced via admit.
    const parsed = DecisionRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      // Delegate to admit so the same fail-closed quarantine path runs.
      return { decision_id: (await this.admit(rawRequest)).decision_id, outcome: "admitted" };
    }
    const incoming = parsed.data;
    const existing = (
      await this.db
        .select({
          decision_id: decisions.decision_id,
          status: decisions.status,
          source_etag: decisions.source_etag,
        })
        .from(decisions)
        .where(eq(decisions.decision_id, incoming.decision_id))
    )[0];

    if (!existing) {
      return { decision_id: (await this.admit(rawRequest)).decision_id, outcome: "admitted" };
    }

    const incomingEtag = incoming.source_etag ?? null;
    if (existing.source_etag === incomingEtag) {
      // same id + same etag -> a re-poll of the unchanged request. Bump last_seen_at.
      await withTx(this.db, async (tx) => {
        await tx
          .update(decisions)
          .set({ last_seen_at: now })
          .where(eq(decisions.decision_id, incoming.decision_id));
      });
      return { decision_id: incoming.decision_id, outcome: "unchanged" };
    }

    // IMPORTANT 3 — supersede REQUIRES a concrete incoming source_etag. Without
    // one we cannot prove a real change, so we must NOT fabricate `"source-edited"`
    // and supersede on it. Fail-closed: a same-id observation that carries no
    // concrete source_etag is treated as `unchanged` (bump last_seen_at), never a
    // fabricated supersede. (The poller always supplies the canonical block etag,
    // so a missing etag here is a degenerate/non-GitHub path.)
    if (incomingEtag === null) {
      await withTx(this.db, async (tx) => {
        await tx
          .update(decisions)
          .set({ last_seen_at: now })
          .where(eq(decisions.decision_id, incoming.decision_id));
      });
      return { decision_id: incoming.decision_id, outcome: "unchanged" };
    }

    // same id + different CONCRETE etag -> the immutable request was edited in
    // place. Only supersede if the item is still non-terminal; a settled
    // (terminal) item stays.
    if (TERMINAL_STATUSES.has(existing.status as ItemStatus)) {
      return { decision_id: incoming.decision_id, outcome: "unchanged" };
    }
    await apply(this.db, incoming.decision_id, "source_superseded", {
      semanticKey: incomingEtag,
      now,
      actor: "observe",
      superseded_by: incomingEtag,
    });
    return { decision_id: incoming.decision_id, outcome: "superseded" };
  }

  /** Record durable §7 worker metadata so mid_run->requeue is implementable. */
  async setWorkerSession(decisionId: string, meta: WorkerSessionMeta): Promise<void> {
    await withTx(this.db, async (tx) => {
      await tx
        .insert(workerSessions)
        .values({
          decision_id: decisionId,
          worker_session_id: meta.worker_session_id ?? null,
          wake_command: meta.wake_command ?? null,
          requeue_command: meta.requeue_command ?? null,
          work_request_ref: meta.work_request_ref ?? null,
          transcript_path: meta.transcript_path ?? null,
        })
        .onConflictDoUpdate({
          target: workerSessions.decision_id,
          set: {
            wake_command: meta.wake_command ?? null,
            requeue_command: meta.requeue_command ?? null,
            work_request_ref: meta.work_request_ref ?? null,
          },
        });
    });
  }

  /**
   * Apply a pure state event (opened, answer_submitted, resume_ack, expire, ...).
   *
   * For the answer path the keyed-HMAC response hasher is always injected
   * (Finding 3), so a low-entropy PHI/secret answer never yields a guessable
   * plaintext-derived hash. A sensitive structured answer (answer_sensitivity
   * phi/secret) carrying a raw `answer_value` is redacted to a protected
   * `answer_ref` here BEFORE apply — the plaintext value never reaches SQLite.
   */
  async applyEvent(
    decisionId: string,
    event: TransitionEvent,
    ctx: Omit<ApplyCtx, "now"> & { now?: string },
  ): Promise<ApplyResult> {
    // Lifecycle fix (live e2e): the §6.2 path is
    //   notified --opened--> viewed --answer_submitted--> ...
    // The real answer path (CLI -> intent socket -> driver) reaches a freshly
    // `notified` item — the operator never separately "opened" it — so applying
    // `answer_submitted` directly threw `illegal transition: (notified)
    // --answer_submitted-->`. An operator answering an item IMPLIES they viewed
    // it, so auto-apply `opened` (notified -> viewed) FIRST, through THIS single
    // writer, then proceed with the answer. We do NOT loosen the §6.2 table to
    // allow answer_submitted from notified; we go through `opened`/`viewed`.
    //
    // Idempotent + no double-`opened`: only when the durable status is still
    // `notified` (an already-`viewed` item — opened via the dashboard/CLI `view`
    // — skips this, so the answer path never double-applies `opened`). The
    // `opened` semantic key is deterministic (the answerer), consistent with the
    // `opened:<viewer>` transition_key scheme.
    if (event === "answer_submitted" && ctx.answer) {
      const current = await this.reader.get(decisionId);
      if (current?.status === "notified") {
        await apply(this.db, decisionId, "opened", {
          semanticKey: ctx.answer.answerer,
          actor: ctx.actor,
          trace_id: ctx.trace_id,
          now: ctx.now ?? this.clock().toISOString(),
        });
      }
    }
    const answer = ctx.answer;
    return apply(this.db, decisionId, event, {
      ...ctx,
      answer,
      responseHash: (canonical: string) => this.protectedStore.responseHmac(canonical),
      now: ctx.now ?? this.clock().toISOString(),
    });
  }

  /**
   * Guarded view-state op (slice 4): pin/mute/defer/need_more_context. These are
   * NOT §6.2 transitions — they do not change durable status, add no lifecycle
   * edge, and run in ONE txn that sets the existing `decisions.pinned/muted/
   * deferred_until` column (or none, for need_more_context) + appends a REDACTED
   * audit row.
   *
   * GUARD: applies only when the durable status is `notified` or `viewed`. On a
   * terminal (`resumed`/`superseded`/`failed`), an in-flight (any other) status,
   * or an unknown id, it is a no-op/reject (no mutation, no audit). The view-state
   * of a settled or in-progress item is meaningless, so it is never touched.
   */
  private async applyWorkflow(
    decisionId: string,
    op: WorkflowAuditEvent,
    now: string,
    actor: string | undefined,
    set: Partial<{ pinned: boolean; muted: boolean; deferred_until: string }>,
    detail?: Record<string, unknown>,
  ): Promise<WorkflowOpResult> {
    return withTx(this.db, async (tx) => {
      const r = (
        await tx
          .select({ status: decisions.status })
          .from(decisions)
          .where(eq(decisions.decision_id, decisionId))
      )[0];
      if (!r) return { applied: false, status: "unknown", reason: "unknown_decision" };
      const status = r.status as ItemStatus;
      // Only an item awaiting a human (notified/viewed) carries a meaningful
      // view-state. Reject/no-op everything else (terminal, superseded, in-flight).
      if (status !== "notified" && status !== "viewed") {
        return { applied: false, status, reason: "not_view_state" };
      }
      if (Object.keys(set).length > 0) {
        await tx
          .update(decisions)
          .set({ ...set, updated_at: now })
          .where(eq(decisions.decision_id, decisionId));
      }
      await appendAudit(tx, {
        decision_id: decisionId,
        from: status,
        to: status,
        event: op,
        actor: actor ?? null,
        at: now,
        // REDACTED detail only — never plaintext. `deferred_until` is an operational
        // timestamp the operator chose, not protected content.
        detail: detail !== undefined ? detail : undefined,
      });
      return { applied: true, status };
    });
  }

  /** Pin an item to the top of the active inbox (guarded view-state op). */
  pin(decisionId: string, opts: WorkflowOpOptions = {}): Promise<WorkflowOpResult> {
    const now = opts.now ?? this.clock().toISOString();
    return this.applyWorkflow(decisionId, "pin", now, opts.actor, { pinned: true });
  }

  /** Mute an item (suppress from the active ranking) — guarded view-state op. */
  mute(decisionId: string, opts: WorkflowOpOptions = {}): Promise<WorkflowOpResult> {
    const now = opts.now ?? this.clock().toISOString();
    return this.applyWorkflow(decisionId, "mute", now, opts.actor, { muted: true });
  }

  /** Defer an item until a timestamp (suppress until then) — guarded view-state op. */
  defer(decisionId: string, until: string, opts: WorkflowOpOptions = {}): Promise<WorkflowOpResult> {
    const now = opts.now ?? this.clock().toISOString();
    return this.applyWorkflow(decisionId, "defer", now, opts.actor, { deferred_until: until }, {
      until,
    });
  }

  /**
   * Record a "need more context" note. No column changes (the actual context-fetch
   * is deferred to a later slice) — only the redacted audit row + the guard.
   */
  needMoreContext(decisionId: string, opts: WorkflowOpOptions = {}): Promise<WorkflowOpResult> {
    const now = opts.now ?? this.clock().toISOString();
    return this.applyWorkflow(decisionId, "need_more_context", now, opts.actor, {});
  }

  /**
   * Reveal a withheld decision field to an authorized operator.
   *
   * SECURITY: the requested `ref` MUST belong to `decisionId` before decrypting.
   * `reader.detail` enumerates every protected ref on the decision (question,
   * context, consequence_of_no_answer, and each option label/detail); if the ref
   * is absent we throw `RevealRefNotFoundError` rather than decrypting arbitrary
   * protected content (e.g. another decision's secret).
   *
   * The original plaintext was JSON-serialized before encryption, so we parse it
   * back to a string. A `reveal` audit row is appended with the operator identity.
   */
  async revealProtected(decisionId: string, ref: string, actor: string): Promise<{ field: string; value: string }> {
    const detail = await this.reader.detail(decisionId);
    if (!detail) {
      throw new RevealRefNotFoundError(decisionId, ref);
    }

    const protectedFields: Array<{ field: string; class: string; ref: string }> = [];
    const collect = (field: DetailField | null) => {
      if (field && field.kind === "protected" && field.ref) {
        protectedFields.push({ field: field.field, class: field.class, ref: field.ref });
      }
    };
    collect(detail.question);
    collect(detail.context);
    collect(detail.consequence_of_no_answer);
    for (const option of detail.options) {
      collect(option.label);
      collect(option.detail ?? null);
    }

    const match = protectedFields.find((f) => f.ref === ref);
    if (!match) {
      throw new RevealRefNotFoundError(decisionId, ref);
    }

    const value = JSON.parse(await this.protectedStore.get(ref)) as string;
    // §3.5a: this audit append runs OUTSIDE any open writer tx, so wrap it in the
    // guarded primitive (acquire the mutex + per-tx advisory lock).
    await withTx(this.db, async (tx) => {
      await appendAudit(tx, {
        decision_id: decisionId,
        event: "reveal",
        actor,
        at: this.clock().toISOString(),
        detail: { field: match.field, class: match.class },
      });
    });
    return { field: match.field, value };
  }

  /** Run a single outbox effect (reserve -> execute -> commit). */
  runEffect(decisionId: string, kind: EffectKind, opts?: RunEffectOptions): Promise<RunEffectResult> {
    return this.outbox.runEffect(decisionId, kind, opts);
  }

  /** State-derived reconcile across all effect kinds (restart recovery). */
  reconcile() {
    return this.outbox.reconcile();
  }

  /**
   * IMPORTANT 2 + FINDING 2 (drive-pending sweep). The ACTUAL pending effects of
   * non-terminal items — each a `(decision_id, kind)` for a RETRYABLE pending
   * (`reserved`, non-exhausted) row that a transient failure left parked. The
   * daemon's periodic sweep re-drives THE REPORTED KIND through the single
   * writer-driver queue, so a transient notify/write/requeue failure is retried
   * without a restart — and a reserved `requeue` left by the mid_run fallback is
   * retried AS requeue (not a state-derived `resume`).
   */
  pendingEffectDecisions(): Promise<PendingEffect[]> {
    return this.outbox.pendingEffectDecisions();
  }

  /** Close the underlying writer connection (graceful shutdown). */
  async close(): Promise<void> {
    // The per-tx advisory xact-lock auto-releases at tx end and the boot
    // fast-fail is non-holding, so there is no session lock to release.
    if (this.sql) {
      await this.sql.end({ timeout: 5 }).catch(() => {});
    }
  }
}
