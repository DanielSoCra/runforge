import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { type EffectKind, type TransitionEvent, type ItemStatus, TERMINAL_STATUSES } from "@auto-claude/decision-protocol";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { decisions, outbox, decisionResponses, workerSessions } from "./schema.js";
import { apply, type ApplyCtx } from "./state-machine.js";
import { effectId } from "./idempotency.js";
import { transition, IllegalTransitionError } from "./transition-table.js";
import { appendAudit } from "./audit-log.js";
import type { Notifier, ProbeResult } from "./adapters/notifier.js";
import type { SourceSink } from "./adapters/source-sink.js";
import type { ResumeDispatcher } from "./adapters/resume-dispatcher.js";

export class EffectFailedError extends Error {
  readonly kind: EffectKind;
  constructor(kind: EffectKind, msg: string) {
    super(`effect ${kind} failed: ${msg}`);
    this.name = "EffectFailedError";
    this.kind = kind;
  }
}

export interface OutboxDeps {
  db: Db;
  notifier: Notifier;
  sourceSink: SourceSink;
  resumeDispatcher: ResumeDispatcher;
  clock: () => Date;
  /** notification channel (semantic key for notify effects). */
  channel?: string;
  maxAttempts?: number;
  /**
   * CRITICAL 1 claim-lease window (ms). Reconcile RE-claims an `executing` row
   * (CAS-claimed but not yet committed) only once its claim is older than this —
   * an orphaned claim from a crashed process. A fresher claim is treated as a
   * LIVE in-flight execution and left alone (reconcile defers), so a generic
   * concurrent reconcile never steals a row a runEffect is actively executing.
   * Default 30_000ms. Boot reconcile runs after a restart, so the prior
   * process's `executing` rows are always older than the lease.
   */
  claimLeaseMs?: number;
  /**
   * CRITICAL 1 (owner/process-generation token). A stable per-process generation
   * id minted once per writer construction. Every `claim()` records it as
   * `claimed_by`; `reconcile()` may reclaim an `executing` row ONLY if its
   * `claimed_by` is a DIFFERENT generation (a prior, dead process). The current
   * process's executing rows are NEVER stolen, regardless of the lease — so a
   * LIVE slow adapter call (e.g. a GitHub call with withBackoff that exceeds the
   * 30s lease) is never re-dispatched. Defaults to a fresh uuid (the production
   * path); tests inject a fixed value to model crash recovery across generations.
   */
  generation?: string;
}

interface ItemEffectRow {
  decision_id: string;
  status: ItemStatus;
  run_id: string;
  resume_mode: "mid_run" | "requeue";
  source_etag: string | null;
  /** operational source locator (issue url/node id) — the freshness probe +
   * writeResponse need it; never redactable (C4). */
  source_url: string;
}

/**
 * A fully-resolved effect: the deterministic id, the transition event applied on
 * confirmed success, and the semantic key for BOTH the effect id and the
 * transition key. Derived from the item's CURRENT state (never hardcoded), so a
 * re_notify cycle carries `re_notify:<cycle>` rather than collapsing onto the
 * original `notify:<channel>` (Finding 6).
 */
interface EffectSpec {
  kind: EffectKind;
  id: string;
  intendedTransition: TransitionEvent;
  /** semantic key for the transition_key (`<event>:<semanticKey>`). */
  transitionSemanticKey: string;
}

/** Optional overrides when an effect models a re-surface (re_notify) cycle. */
export interface RunEffectOptions {
  /** for a notify effect that should apply `re_notify:<cycle>` instead of `notify:<channel>`. */
  reNotifyCycle?: string;
}

/**
 * FINDING 2 — one ACTUAL pending effect: the live reserved row's own kind keyed
 * by its decision. The drive-pending sweep re-drives THIS kind via
 * `runEffect(decision_id, kind)` (never a state-derived guess), so a reserved
 * requeue left by the mid_run fallback is retried AS requeue, not as resume.
 */
export interface PendingEffect {
  decision_id: string;
  kind: EffectKind;
}

export interface RunEffectResult {
  status: ItemStatus;
  /** the effect kind actually executed (may differ from requested for resume fallback). */
  kind: EffectKind;
  /**
   * `deferred` — the fail-closed source-freshness guard (A3/C2) could not
   * positively confirm the source is unchanged (an `unknown` probe), so NO
   * adapter was dispatched and the reserved row is left for a later retry. Never
   * resume on uncertainty.
   */
  outcome: "committed" | "superseded" | "failed" | "deferred";
  /** follow-on effects to run next (e.g. resume after source_written). */
  effects: EffectKind[];
}

export class Outbox {
  private readonly db: Db;
  private readonly notifier: Notifier;
  private readonly sourceSink: SourceSink;
  private readonly resumeDispatcher: ResumeDispatcher;
  private readonly clock: () => Date;
  private readonly channel: string;
  private readonly maxAttempts: number;
  private readonly claimLeaseMs: number;
  /** CRITICAL 1: this process's stable generation id (the claim owner token). */
  private readonly generation: string;

  constructor(deps: OutboxDeps) {
    this.db = deps.db;
    this.notifier = deps.notifier;
    this.sourceSink = deps.sourceSink;
    this.resumeDispatcher = deps.resumeDispatcher;
    this.clock = deps.clock;
    this.channel = deps.channel ?? "default";
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.claimLeaseMs = deps.claimLeaseMs ?? 30_000;
    this.generation = deps.generation ?? randomUUID();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private loadItem(decisionId: string): ItemEffectRow {
    const r = this.db
      .select({
        decision_id: decisions.decision_id,
        status: decisions.status,
        run_id: decisions.run_id,
        resume_mode: decisions.resume_mode,
        source_etag: decisions.source_etag,
        source_url: decisions.source_url,
      })
      .from(decisions)
      .where(eq(decisions.decision_id, decisionId))
      .all()[0];
    if (!r) throw new Error(`unknown decision ${decisionId}`);
    return {
      ...r,
      status: r.status as ItemStatus,
      resume_mode: r.resume_mode as "mid_run" | "requeue",
    };
  }

  /** Deterministic id-key per effect kind (reconstructable from item state). */
  private effectIdKey(kind: EffectKind, item: ItemEffectRow, responseKey: string | null): string {
    switch (kind) {
      case "notify":
        return this.channel;
      case "write_response":
        return responseKey ?? item.decision_id;
      case "resume":
      case "requeue":
        return item.run_id;
    }
  }

  private responseKey(decisionId: string): string | null {
    const r = this.db
      .select({ k: decisionResponses.response_idempotency_key })
      .from(decisionResponses)
      .where(eq(decisionResponses.decision_id, decisionId))
      .all()[0];
    return r?.k ?? null;
  }

  /** Load the postable answer payload for the source write (C1). */
  private responseRow(decisionId: string): {
    responsePayloadJson: string | null;
    answerRef: string | null;
  } {
    const r = this.db
      .select({
        responsePayloadJson: decisionResponses.response_payload_json,
        answerRef: decisionResponses.answer_ref,
      })
      .from(decisionResponses)
      .where(eq(decisionResponses.decision_id, decisionId))
      .all()[0];
    return {
      responsePayloadJson: r?.responsePayloadJson ?? null,
      answerRef: r?.answerRef ?? null,
    };
  }

  /**
   * Build the fully-resolved EffectSpec for the requested kind from the item's
   * CURRENT state. Carries the intended transition event + its semantic key
   * (Finding 6: no hardcoded `INTENDED[kind]`). A `re_notify` cycle yields a
   * distinct id (`notify:<channel>:<cycle>` keyed) and a `re_notify:<cycle>`
   * intended transition; the first notify yields `notify:<channel>`.
   */
  private effectSpecFor(item: ItemEffectRow, kind: EffectKind, opts?: RunEffectOptions): EffectSpec {
    const responseKey = this.responseKey(item.decision_id);
    let idKey = this.effectIdKey(kind, item, responseKey);
    let intendedTransition: TransitionEvent;
    let transitionSemanticKey: string;

    switch (kind) {
      case "notify": {
        if (opts?.reNotifyCycle !== undefined) {
          // re-surface: distinct id + re_notify transition keyed by cycle.
          idKey = `${this.channel}:${opts.reNotifyCycle}`;
          intendedTransition = "re_notify";
          transitionSemanticKey = opts.reNotifyCycle;
        } else {
          intendedTransition = "notify";
          transitionSemanticKey = this.channel;
        }
        break;
      }
      case "write_response": {
        intendedTransition = "write_response";
        transitionSemanticKey = idKey;
        break;
      }
      case "resume":
      case "requeue": {
        intendedTransition = "resume_dispatch";
        transitionSemanticKey = idKey;
        break;
      }
    }

    return {
      kind,
      id: effectId(item.decision_id, kind, idKey),
      intendedTransition,
      transitionSemanticKey,
    };
  }

  /** Deterministic id for an effect, reconstructable WITHOUT the outbox row. */
  effectIdFor(decisionId: string, kind: EffectKind, opts?: RunEffectOptions): string {
    const item = this.loadItem(decisionId);
    return this.effectSpecFor(item, kind, opts).id;
  }

  /** Phase 1: reserve (txn). Idempotent on the deterministic id. */
  private reserve(spec: EffectSpec, decisionId: string): void {
    withTx(this.db, (tx) => {
      const existing = tx.select().from(outbox).where(eq(outbox.id, spec.id)).all()[0];
      if (existing) return; // already reserved (or committed) — idempotent
      tx.insert(outbox)
        .values({
          id: spec.id,
          decision_id: decisionId,
          kind: spec.kind,
          intended_transition: spec.intendedTransition,
          // Finding I6: persist the transition semantic key EXPLICITLY so reconcile
          // recovers it from this column (a re_notify cycle may contain ':').
          semantic_key: spec.transitionSemanticKey,
          payload_ref: null,
          state: "reserved",
          attempts: 0,
          created_at: this.now(),
        })
        .run();
    });
  }

  /**
   * CRITICAL 1 — durable CAS claim. Transition the row `reserved -> executing`
   * in its OWN committed txn BEFORE any adapter await, so a concurrent
   * runEffect()/reconcile() that passed the same pre-await guard cannot ALSO
   * dispatch the same effect. The flip is a conditional UPDATE
   * (`WHERE id=? AND state='reserved'`); we then re-read to learn whether THIS
   * caller won the race:
   *   - row now `executing` AND we observed it `reserved` pre-flip -> WE claimed it,
   *     proceed to dispatch the adapter;
   *   - row already `executing`/`committed`/`failed` -> a concurrent claim (or a
   *     prior crash) owns it: BACK OFF, never touch the adapter.
   * better-sqlite3 serializes writes on the single connection, so the
   * conditional UPDATE is atomic; the loser's UPDATE matches zero rows.
   */
  private claim(id: string): boolean {
    const now = this.now();
    return withTx(this.db, (tx) => {
      const before = tx.select({ state: outbox.state }).from(outbox).where(eq(outbox.id, id)).all()[0];
      if (!before || before.state !== "reserved") return false; // already claimed/settled
      tx.update(outbox)
        // CRITICAL 1: stamp BOTH the lease timestamp and the owner generation, so
        // reconcile can distinguish a LIVE current-process claim from a crashed
        // prior-process one.
        .set({ state: "executing", claimed_at: now, claimed_by: this.generation })
        .where(and(eq(outbox.id, id), eq(outbox.state, "reserved")))
        .run();
      const after = tx.select({ state: outbox.state }).from(outbox).where(eq(outbox.id, id)).all()[0];
      // we win only if the flip we just issued is the one that set `executing`.
      return after?.state === "executing";
    });
  }

  /** Is an `executing` row's claim older than the lease window (an orphaned
   * claim from a crashed process)? A fresh claim is a LIVE in-flight execution. */
  private claimIsStale(claimedAt: string | null): boolean {
    if (!claimedAt) return true; // no timestamp -> treat as recoverable (legacy/forced)
    const age = this.clock().getTime() - new Date(claimedAt).getTime();
    return age >= this.claimLeaseMs;
  }

  /**
   * CRITICAL 1 — may reconcile RECLAIM this `executing` row? OWNERSHIP is the
   * gate: a row whose `claimed_by` is the CURRENT generation is owned by THIS
   * live process and is NEVER reclaimed, regardless of the lease — the current
   * process serializes its own writes, so its executing rows are genuinely
   * in-flight (a long-running but live adapter call, e.g. a GitHub call with
   * withBackoff exceeding the 30s lease, must not be re-dispatched). A row owned
   * by a DIFFERENT (prior, dead) generation IS a crash-recovery candidate. The
   * lease remains a SECONDARY signal for prior-generation rows: we additionally
   * require the claim to be stale, so a brief generation handoff (vanishingly
   * rare) never steals a still-warm prior claim. A row with NO `claimed_by`
   * (legacy/forced) falls back to the lease-only rule.
   */
  private executingIsReclaimable(claimedBy: string | null, claimedAt: string | null): boolean {
    if (claimedBy === this.generation) return false; // owned by THIS live process — never steal
    if (claimedBy === null) return this.claimIsStale(claimedAt); // legacy/forced -> lease-only
    // a DIFFERENT (prior) generation: crash-recoverable once its lease expired.
    return this.claimIsStale(claimedAt);
  }

  /** Release a claimed (`executing`) row back to `reserved` for a later retry
   * (transient failure / deferred freshness probe). Idempotent; leaves
   * committed/failed/superseded rows untouched. */
  private releaseClaim(id: string): void {
    withTx(this.db, (tx) => {
      tx.update(outbox)
        // clear the owner token too: a released row is back to unclaimed `reserved`.
        .set({ state: "reserved", claimed_at: null, claimed_by: null })
        .where(and(eq(outbox.id, id), eq(outbox.state, "executing")))
        .run();
    });
  }

  /**
   * Phase 3: commit — mark the outbox row committed AND apply the intended
   * transition (+ audit + applied_transitions) in a SINGLE transaction so a
   * crash can never leave an advanced state with a stale `reserved` outbox row
   * (Finding 5). `apply` is itself transactional; we run it inside the same
   * outer txn and update the outbox row before returning.
   */
  private commit(spec: EffectSpec, decisionId: string, supersededBy?: string): ItemStatus {
    const status = withTx(this.db, (tx) => {
      const res = apply(tx, decisionId, spec.intendedTransition, {
        semanticKey: spec.transitionSemanticKey,
        now: this.now(),
        actor: "outbox",
        superseded_by: supersededBy,
      });
      tx.update(outbox)
        .set({ state: "committed", committed_at: this.now() })
        .where(eq(outbox.id, spec.id))
        .run();
      return res.status;
    });
    // INVARIANT (a): if this commit advanced the decision INTO a terminal state
    // (e.g. resume_ack -> resumed), cancel any sibling reserved rows. The row we
    // just committed is already `committed`, so cancelReservedRows leaves it alone.
    if (TERMINAL_STATUSES.has(status)) {
      this.cancelReservedRows(decisionId);
    }
    return status;
  }

  /**
   * A4 — crash-safe requeue terminality. On a CONFIRMED resume/requeue the only
   * edge to terminal is `resume_requested --resume_ack--> resumed`, and there is
   * no `source_written --> resumed` edge. So a confirmed dispatch commits BOTH
   * transitions atomically in ONE txn: `resume_dispatch` (source_written ->
   * resume_requested) AND `resume_ack:<run_id>` (resume_requested -> resumed), so
   * success lands directly in terminal `resumed` with NO separate, crashable
   * daemon step. Two DISTINCT applied_transitions keys (resume_dispatch:<run_id>,
   * resume_ack:<run_id>). The outbox row is marked committed in the same txn.
   *
   * If a prior reconcile already applied resume_dispatch (status is already
   * resume_requested — a crash recovered the dispatch), the resume_dispatch apply
   * is an idempotent no-op (same applied key) and only resume_ack fires.
   */
  private commitResumeTerminal(spec: EffectSpec, decisionId: string): ItemStatus {
    const runIdKey = spec.transitionSemanticKey; // == item.run_id for resume/requeue
    const status = withTx(this.db, (tx) => {
      // (1) resume_dispatch: source_written -> resume_requested (idempotent if
      //     already applied by a recovered crash).
      apply(tx, decisionId, "resume_dispatch", {
        semanticKey: runIdKey,
        now: this.now(),
        actor: "outbox",
      });
      // (2) resume_ack: resume_requested -> resumed (terminal), SAME txn.
      const acked = apply(tx, decisionId, "resume_ack", {
        semanticKey: runIdKey,
        now: this.now(),
        actor: "outbox",
      });
      tx.update(outbox)
        .set({ state: "committed", committed_at: this.now() })
        .where(eq(outbox.id, spec.id))
        .run();
      return acked.status;
    });
    if (TERMINAL_STATUSES.has(status)) {
      this.cancelReservedRows(decisionId);
    }
    return status;
  }

  /**
   * A4 recovery — apply only the terminal `resume_ack` for a decision that is
   * ALREADY `resume_requested` (a crash committed resume_dispatch but not
   * resume_ack). The dispatch already happened; the marker probe confirmed
   * applied, so we never re-dispatch — we just finish the atomic pair.
   */
  private applyResumeAck(spec: EffectSpec, decisionId: string): ItemStatus {
    const status = withTx(this.db, (tx) => {
      const acked = apply(tx, decisionId, "resume_ack", {
        semanticKey: spec.transitionSemanticKey,
        now: this.now(),
        actor: "reconcile",
      });
      tx.update(outbox)
        .set({ state: "committed", committed_at: this.now() })
        .where(eq(outbox.id, spec.id))
        .run();
      return acked.status;
    });
    if (TERMINAL_STATUSES.has(status)) {
      this.cancelReservedRows(decisionId);
    }
    return status;
  }

  private async markSuperseded(decisionId: string, newEtag: string): Promise<ItemStatus> {
    const res = withTx(this.db, (tx) =>
      apply(tx, decisionId, "source_superseded", {
        semanticKey: newEtag,
        now: this.now(),
        actor: "outbox",
        superseded_by: newEtag,
      }),
    );
    // INVARIANT (a): superseded is terminal — cancel any outstanding reserved
    // rows (e.g. the write_response row that just precondition-failed) so a later
    // reconcile never re-dispatches a stale external write against this decision.
    this.cancelReservedRows(decisionId);
    await this.sourceSink.markSuperseded(decisionId, newEtag);
    return res.status;
  }

  /**
   * Record one failed attempt against the triggering outbox row and, IFF the
   * attempt budget is now exhausted, drive the WHOLE failure transition ATOMICALLY
   * (Finding: failure crash-atomicity). In a SINGLE transaction on exhaustion we:
   *   1. bump attempts + persist last_error,
   *   2. mark the triggering outbox row terminal (`state="failed"`),
   *   3. mark the decision `status="failed"`,
   *   4. write the terminal audit row, AND
   *   5. cancel/supersede all the decision's OTHER non-committed reserved rows.
   * There is NO partial-commit window: a crash either leaves the row still
   * `reserved` (attempts bumped, decision non-terminal — a clean retry) or leaves
   * BOTH the row terminal AND the decision `failed` with zero live reserved rows.
   * The OLD split (bumpFailure committed `state="failed"` BEFORE failItem marked
   * the decision) could die in between, stranding an exhausted `failed` row on a
   * NON-terminal decision that reconcile would re-derive + re-dispatch (double
   * external effect). That window no longer exists.
   *
   * Returns `{ attempts, exhausted, status }`; `status` is `"failed"` when the
   * transition fired, else the decision's unchanged (retryable) status.
   */
  private recordFailure(
    id: string,
    decisionId: string,
    msg: string,
  ): { attempts: number; exhausted: boolean; status: ItemStatus } {
    return withTx(this.db, (tx) => {
      const row = tx.select().from(outbox).where(eq(outbox.id, id)).all()[0]!;
      const attempts = row.attempts + 1;
      const exhausted = attempts >= this.maxAttempts;
      if (!exhausted) {
        // transient failure: bump + release back to (unclaimed) reserved so a
        // retry can re-claim. Clearing the owner token avoids a released row
        // looking like a live current-process claim to a later reconcile.
        tx.update(outbox)
          .set({ attempts, last_error: msg, state: "reserved", claimed_at: null, claimed_by: null })
          .where(eq(outbox.id, id))
          .run();
        const cur = tx
          .select({ status: decisions.status })
          .from(decisions)
          .where(eq(decisions.decision_id, decisionId))
          .all()[0]!;
        return { attempts, exhausted: false, status: cur.status as ItemStatus };
      }

      // EXHAUSTED — atomic terminal failure transition, all in THIS txn.
      const now = this.now();
      const cur = tx
        .select({ status: decisions.status })
        .from(decisions)
        .where(eq(decisions.decision_id, decisionId))
        .all()[0]!;
      // (2) triggering outbox row -> terminal.
      tx.update(outbox)
        .set({ attempts, last_error: msg, state: "failed" })
        .where(eq(outbox.id, id))
        .run();
      // (3) decision -> failed.
      tx.update(decisions)
        .set({ status: "failed", updated_at: now })
        .where(eq(decisions.decision_id, decisionId))
        .run();
      // (4) terminal audit row.
      appendAudit(tx, {
        decision_id: decisionId,
        from: cur.status as ItemStatus,
        to: "failed",
        // `fail` is an escalation, not a §6.2 transition-table event; recorded as
        // the audit-only sub-step kind to keep the audit trail complete.
        event: "fail",
        actor: "outbox",
        at: now,
        detail: { effect_id: id, last_error: msg, attempts },
      });
      // (5) INVARIANT (a): a terminal decision owns NO live reserved effect.
      // Cancel ALL OTHER non-committed reserved rows. The triggering row is now
      // `state="failed"` (not "reserved"), so this leaves it as terminal evidence.
      tx.update(outbox)
        .set({ superseded: true })
        .where(and(eq(outbox.decision_id, decisionId), ne(outbox.state, "committed")))
        .run();
      return { attempts, exhausted: true, status: "failed" as ItemStatus };
    });
  }

  /**
   * Idempotently re-apply the terminal failure transition for a LIMBO decision
   * recovered at reconcile time: an outbox row is already `state="failed"` with
   * attempts exhausted, but the decision was never marked `failed` (a crash in the
   * OLD split window). Drive the decision to `failed` + audit + cancel reserved
   * rows in ONE txn. NEVER re-dispatches the adapter. Idempotent if already failed.
   */
  private failDecisionTerminal(decisionId: string, triggeringId: string, msg: string): ItemStatus {
    return withTx(this.db, (tx) => {
      const cur = tx
        .select({ status: decisions.status })
        .from(decisions)
        .where(eq(decisions.decision_id, decisionId))
        .all()[0]!;
      if (TERMINAL_STATUSES.has(cur.status as ItemStatus)) {
        return cur.status as ItemStatus; // already terminal — idempotent no-op
      }
      const now = this.now();
      tx.update(decisions)
        .set({ status: "failed", updated_at: now })
        .where(eq(decisions.decision_id, decisionId))
        .run();
      appendAudit(tx, {
        decision_id: decisionId,
        from: cur.status as ItemStatus,
        to: "failed",
        event: "fail",
        actor: "reconcile",
        at: now,
        detail: { effect_id: triggeringId, last_error: msg, recovered: "limbo" },
      });
      tx.update(outbox)
        .set({ superseded: true })
        .where(and(eq(outbox.decision_id, decisionId), ne(outbox.state, "committed")))
        .run();
      return "failed" as ItemStatus;
    });
  }

  /** Is the decision's CURRENT durable status terminal (resumed/superseded/failed)? */
  private isTerminal(decisionId: string): boolean {
    const r = this.db
      .select({ status: decisions.status })
      .from(decisions)
      .where(eq(decisions.decision_id, decisionId))
      .all()[0];
    return r ? TERMINAL_STATUSES.has(r.status as ItemStatus) : false;
  }

  /**
   * INVARIANT (a): durably cancel ALL outstanding (non-committed) outbox rows for
   * a decision the moment it reaches a terminal state. We reuse the durable
   * `superseded` boolean as the cancel marker so a `reserved` row can never be
   * re-executed/committed by a later reconcile against a terminal decision — even
   * across restart. Committed rows are left untouched (they record a real effect).
   * Idempotent: a row already marked stays marked.
   */
  private cancelReservedRows(decisionId: string): void {
    withTx(this.db, (tx) => {
      tx.update(outbox)
        .set({ superseded: true })
        .where(and(eq(outbox.decision_id, decisionId), ne(outbox.state, "committed")))
        .run();
    });
  }

  /**
   * STRANDING FIX (verdict fix_before_flag_on, outbox.ts ~740): a CLAIMED
   * (`executing`) row whose adapter await THROWS/REJECTS — vs. returning a
   * structured `failed` — must never be left stuck `executing`. Same-process
   * reconcile skips current-generation `executing` rows by design (they look like
   * a live in-flight claim), so an un-caught adapter throw would strand the row
   * until process restart. Treat a thrown adapter exactly like a structured
   * transient failure: recordFailure() bumps the attempt and releases the claim
   * back to `reserved` (or, on exhaustion, drives the decision terminal `failed`)
   * — then RE-THROW so the caller/daemon tick still sees the error. The DB row is
   * settled BEFORE the throw propagates, so no row is ever orphaned `executing`.
   */
  private async dispatchClaimed<T>(
    id: string,
    decisionId: string,
    label: string,
    adapterCall: () => Promise<T>,
  ): Promise<T> {
    try {
      return await adapterCall();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Record the attempt + release/terminal the claim defensively. If THIS
      // itself throws (a SQLite-level failure), the original error still wins.
      try {
        this.recordFailure(id, decisionId, `${label} threw: ${msg}`);
      } catch {
        // best-effort settle; surface the original adapter error below.
      }
      throw err;
    }
  }

  /**
   * Run one effect end-to-end: reserve -> execute (deterministic id) -> commit.
   * Returns the resulting status + any follow-on effects.
   */
  async runEffect(decisionId: string, kind: EffectKind, opts?: RunEffectOptions): Promise<RunEffectResult> {
    const item = this.loadItem(decisionId);
    const spec = this.effectSpecFor(item, kind, opts);

    // TERMINAL SHORT-CIRCUIT (chokepoint idempotency): a decision already in a
    // terminal status (resumed/superseded/failed) is settled — re-calling
    // runEffect for it is an idempotent no-op, NOT an illegal-transition error.
    // We route directly into the chokepoint guard (which cancels any stray
    // reserved rows and returns without dispatching) instead of letting the pure
    // preflight below throw `IllegalTransitionError` for an effect that simply
    // arrived after the decision settled. This mirrors reconcile's terminal guard
    // (0/0b): once failed via the chokepoint, a repeat call no-ops the same way.
    if (this.isTerminal(decisionId)) {
      return await this.executeReserved(decisionId, item, spec);
    }

    // CRITICAL (Finding 1): preflight the PURE state guard BEFORE any reserve or
    // adapter call. We probe the spec's intended transition against the pure
    // transition table; an illegal (from,event) throws here — the adapter is
    // NEVER touched, no outbox row is reserved, and state is not mutated.
    transition(
      { status: item.status, stale: false, resume_mode: item.resume_mode },
      spec.intendedTransition,
      { superseded_by: "preflight" },
    );

    this.reserve(spec, decisionId);
    return await this.executeReserved(decisionId, item, spec);
  }

  /**
   * Step 2 (execute) + step 3 (commit) for an ALREADY-reserved spec. The spec is
   * the source of truth for the intended transition + semantic key (so a recovered
   * re_notify row keeps its `re_notify:<cycle>` key); the reserve row already
   * exists. Used by both runEffect (fresh) and reconcile (crash-before-execute).
   */
  private async executeReserved(
    decisionId: string,
    item: ItemEffectRow,
    spec: EffectSpec,
  ): Promise<RunEffectResult> {
    const kind = spec.kind;
    const id = spec.id;

    // UNIFIED GUARD (the single effect-execution chokepoint): EVERY adapter call
    // — write_response/resume/requeue/notify, from BOTH runEffect() and
    // reconcile()->executeReserved() — passes through HERE. The guard is TOTAL:
    // NO adapter is ever dispatched for a row that is not CURRENTLY a live
    // `reserved` row on a non-terminal, non-superseded decision — regardless of
    // the caller. We REFUSE to call the adapter when ANY of:
    //   (1) the decision is ALREADY in a terminal status (resumed/superseded/
    //       failed) — even if terminal cleanup (b) was missed (out-of-band
    //       supersede, lost marker, legacy row); OR
    //   (2) THIS reserved row is itself superseded/cancelled (the durable
    //       `superseded` marker) — e.g. a mid_run `resume` reservation that a
    //       requeue fallback superseded while the decision is still
    //       `source_written`. Finding 1: a retry runEffect(id,"resume") used to
    //       pass the pure-state preflight (source_written -> resume_dispatch is
    //       legal) and, since the decision was NOT terminal, dispatch the STALE
    //       mid_run wake. Refusing on the superseded row closes that path — the
    //       live recovery effect is the requeue, never this resume; OR
    //   (3) the persisted row.state is NOT "reserved" (e.g. "committed" or
    //       "failed"). FINAL gap: the PUBLIC runEffect() path used to check only
    //       terminal-decision + superseded, never the row's own state. So an
    //       exhausted `state="failed"` row on a STILL-non-terminal decision (the
    //       OLD-split crash limbo) — when runEffect(id, kind) is called BEFORE any
    //       reconcile — would `reserve()` no-op on that failed row and dispatch the
    //       adapter AGAIN (the exact double-dispatch reconcile's 0b guard prevents).
    //       A "committed" row likewise records a real applied effect and must never
    //       be re-dispatched. Only a CURRENTLY `reserved` row is a live effect.
    // On refusal we cancel the row (idempotent) and return WITHOUT touching the
    // adapter. This is the last line guaranteeing no stale external effect is ever
    // dispatched for a terminal decision, a superseded reservation, or a row that
    // already reached a terminal/applied row-state.
    const persistedRow = this.db
      .select({ state: outbox.state, superseded: outbox.superseded, attempts: outbox.attempts, last_error: outbox.last_error })
      .from(outbox)
      .where(eq(outbox.id, id))
      .all()[0];
    const rowSuperseded = persistedRow?.superseded === true;
    if (this.isTerminal(decisionId)) {
      // Terminal decision: cancel ALL its outstanding reserved rows.
      this.cancelReservedRows(decisionId);
      return { status: this.loadItem(decisionId).status, kind, outcome: "superseded", effects: [] };
    }
    if (rowSuperseded) {
      // Superseded reservation on a NON-terminal decision: this specific row must
      // not be dispatched, but sibling LIVE rows (e.g. the requeue fallback that
      // superseded this resume) are the real recovery path — leave them untouched.
      // The row is already marked superseded; refuse and return without the adapter.
      return { status: this.loadItem(decisionId).status, kind, outcome: "superseded", effects: [] };
    }
    if (persistedRow && persistedRow.state === "failed" && persistedRow.attempts >= this.maxAttempts) {
      // Exhausted terminal-on-row failure whose decision was never marked failed
      // (OLD-split crash limbo). Drive the decision terminal via the SAME
      // idempotent helper reconcile's 0b guard uses — no adapter dispatch.
      const status = this.failDecisionTerminal(
        decisionId,
        id,
        persistedRow.last_error ?? "effect attempts exhausted",
      );
      return { status, kind, outcome: "failed", effects: [] };
    }
    if (persistedRow && persistedRow.state === "committed") {
      // Already-applied effect for this id: never re-dispatch the adapter.
      return { status: this.loadItem(decisionId).status, kind, outcome: "superseded", effects: [] };
    }

    // CRITICAL 1 — durable CAS claim BEFORE any adapter await. Flip the row
    // `reserved -> executing` in its own committed txn. ONLY the winning claimer
    // proceeds to dispatch; a concurrent runEffect()/reconcile() that passed the
    // same read-only guards above finds the row already `executing` (or non-
    // `reserved`) and BACKS OFF here — never touching the adapter. This closes
    // the window where the row stayed `reserved` across the adapter await and two
    // callers both dispatched the same check-then-post effect (double-post). A
    // `failed` (non-exhausted, retryable) or `reserved` row is claimable; a row
    // already `executing` belongs to a concurrent claimer / a prior crash (which
    // reconcile recovers), so we refuse without re-dispatch.
    if (!this.claim(id)) {
      return { status: this.loadItem(decisionId).status, kind, outcome: "deferred", effects: [] };
    }

    if (kind === "notify") {
      const out = await this.dispatchClaimed(id, decisionId, "notify", () =>
        this.notifier.notify({ decision_id: decisionId, channel: this.channel, effectId: id }),
      );
      if (out === "failed") {
        const f = this.recordFailure(id, decisionId, "notify failed");
        return { status: f.status, kind, outcome: "failed", effects: [] };
      }
      const status = this.commit(spec, decisionId);
      return { status, kind, outcome: "committed", effects: [] };
    }

    if (kind === "write_response") {
      const resp = this.responseRow(decisionId);
      const res = await this.dispatchClaimed(id, decisionId, "writeResponse", () =>
        this.sourceSink.writeResponse({
          decision_id: decisionId,
          responseRef: this.responseKey(decisionId) ?? decisionId,
          expectedSourceEtag: item.source_etag,
          effectId: id,
          sourceLocator: item.source_url,
          responsePayloadJson: resp.responsePayloadJson,
          answerRef: resp.answerRef,
          // a protected (phi/secret) answer has no postable payload — only a ref.
          hasProtectedAnswer: resp.responsePayloadJson === null && resp.answerRef !== null,
        }),
      );
      if (res.status === "precondition_failed") {
        // Record the CONCRETE current source etag as superseded_by (no fabricated
        // `${old}-changed`): a real, verifiable etag drives the supersession.
        const status = await this.markSuperseded(decisionId, res.currentSourceEtag);
        return { status, kind, outcome: "superseded", effects: [] };
      }
      if (res.status === "failed") {
        const f = this.recordFailure(id, decisionId, `writeResponse failed: ${res.error}`);
        return { status: f.status, kind, outcome: "failed", effects: [] };
      }
      const status = this.commit(spec, decisionId);
      // follow-on: dispatch resume/requeue per resume_mode
      const next: EffectKind = item.resume_mode === "requeue" ? "requeue" : "resume";
      return { status, kind, outcome: "committed", effects: [next] };
    }

    // resume / requeue
    return await this.runResume(decisionId, item, spec);
  }

  private async runResume(
    decisionId: string,
    item: ItemEffectRow,
    spec: EffectSpec,
  ): Promise<RunEffectResult> {
    const kind = spec.kind;
    const id = spec.id;

    // A3 — FAIL-CLOSED source-freshness guard. Before dispatching ANY
    // resume/requeue for a source_written item, probe the CURRENT source etag and
    // dispatch ONLY if it is POSITIVELY confirmed equal to item.source_etag. This
    // closes the boot-reconcile-requeues-a-stale-answer race after an issue-body
    // edit. A source_changed result supersedes (with the concrete etag) and never
    // resumes; an unknown/error probe defers (leaves the row reserved) — we never
    // resume on uncertainty (mirrors slice-1's fail-closed `unknown` handling).
    const fresh = await this.dispatchClaimed(id, decisionId, "currentEtag", () =>
      this.sourceSink.currentEtag(item.source_url, item.source_etag),
    );
    // IMPORTANT 3 — a `source_changed` result supersedes ONLY with a CONCRETE
    // currentSourceEtag. A source_changed with NO concrete etag is unverifiable;
    // we must NOT fabricate `${old}-changed`. Demote it to the fail-closed
    // `unknown`/defer path (leave the row claimed-then-released, never resume on
    // uncertainty, never record a fabricated supersede etag).
    if (fresh.status === "source_changed" && fresh.currentSourceEtag !== undefined) {
      const status = await this.markSuperseded(decisionId, fresh.currentSourceEtag);
      return { status, kind, outcome: "superseded", effects: [] };
    }
    if (fresh.status !== "equal") {
      // unknown / indeterminate — INCLUDING a `source_changed` without a concrete
      // currentSourceEtag (IMPORTANT 3): do NOT dispatch and do NOT fabricate a
      // supersede etag. RELEASE the CAS claim (back to `reserved`) so a later
      // retry/reconcile can re-claim it; the decision stays source_written.
      // Never resume on uncertainty (fail-closed).
      this.releaseClaim(id);
      return { status: item.status, kind, outcome: "deferred", effects: [] };
    }

    const ws = this.db
      .select()
      .from(workerSessions)
      .where(eq(workerSessions.decision_id, decisionId))
      .all()[0];
    const res = await this.dispatchClaimed(id, decisionId, "resume", () =>
      this.resumeDispatcher.resume({
        decision_id: decisionId,
        mode: kind === "requeue" ? "requeue" : "mid_run",
        effectId: id,
        wake_command: ws?.wake_command ?? null,
        requeue_command: ws?.requeue_command ?? null,
        work_request_ref: ws?.work_request_ref ?? null,
      }),
    );

    if (res === "acked") {
      // A4: a confirmed resume/requeue lands DIRECTLY in terminal `resumed`
      // (atomic resume_dispatch + resume_ack), no separate daemon ack step.
      const status = this.commitResumeTerminal(spec, decisionId);
      return { status, kind, outcome: "committed", effects: [] };
    }

    if (res === "unreachable" && kind === "resume") {
      // §7 fallback: mid_run unreachable -> requeue using durable worker metadata.
      // Reserve the requeue outbox row FIRST so the fallback intent is durable:
      // if we crash after the requeue ack but before commit, reconcile finds the
      // reserved requeue row and probes the REQUEUE id (not the resume id),
      // preventing a second requeue dispatch (Finding 4).
      const requeueSpec = this.effectSpecFor(item, "requeue");
      this.reserve(requeueSpec, decisionId);
      // The fallback requeue SUPERSEDES this resume reservation: the two are not
      // independent recovery effects. Mark the resume row superseded DURABLY so a
      // crash-before-execute on both never re-executes a stale mid_run wake AND a
      // restart for the same decision (reconcile re-executes only the live
      // requeue). The marker survives restart — it is the source of truth. We mark
      // it BEFORE dispatching the requeue so the supersession is durable even if
      // the chokepoint refuses (the requeue is the single live recovery effect).
      //
      // FINDING 2 (b): the resume row was CAS-claimed (`executing`) before its
      // dispatch. SETTLE it back to (unclaimed) `reserved` as we supersede it — a
      // superseded reservation left `executing` would look like a live in-flight
      // claim to reconcile's 0a guard (deferring the whole decision until the lease
      // expires) and to pendingEffectDecisions, worsening recovery. A superseded
      // `reserved` row is inert evidence (the chokepoint refuses it on `superseded`),
      // and the live recovery effect is the requeue.
      this.db
        .update(outbox)
        .set({ superseded: true, state: "reserved", claimed_at: null, claimed_by: null })
        .where(eq(outbox.id, spec.id))
        .run();
      // FINDING 3: route the fallback requeue dispatch through executeReserved —
      // the SINGLE adapter-dispatch chokepoint — instead of claiming + calling the
      // dispatcher directly (which IGNORED the claim result and bypassed the
      // row-state/superseded/terminal guard). executeReserved performs the durable
      // CAS claim itself and REFUSES to dispatch when the requeue row is already
      // claimed/committed/superseded or the decision is terminal — so a concurrent
      // reconcile that already recovered + dispatched the requeue can never trigger
      // a second resume. On a confirmed requeue it lands directly in terminal
      // `resumed` (A4) via commitResumeTerminal, exactly as the inline path did.
      const r2 = await this.executeReserved(decisionId, item, requeueSpec);
      return { status: r2.status, kind: "requeue", outcome: r2.outcome, effects: r2.effects };
    }

    // failed (or requeue unreachable) -> record (atomic terminal on exhaustion)
    const f = this.recordFailure(id, decisionId, `${kind} ${res}`);
    return { status: f.status, kind, outcome: "failed", effects: [] };
  }

  /**
   * State-derived reconcile (restart recovery). For each effect EXPECTED given
   * the item's current status, probe the owning adapter by the deterministic id:
   *   applied  -> mark committed + advance state (idempotent; NO re-dispatch)
   *   absent   -> re-execute the effect
   *   unknown  -> mark the item failed (needs-human; never risk duplication)
   * Covers ALL effect kinds, not just source writes.
   */
  async reconcile(): Promise<{ decision_id: string; kind: EffectKind; action: string; status: ItemStatus }[]> {
    const out: { decision_id: string; kind: EffectKind; action: string; status: ItemStatus }[] = [];
    const items = this.db.select().from(decisions).all();
    for (const row of items) {
      const status = row.status as ItemStatus;
      const item = this.loadItem(row.decision_id);

      // (0) DEFENSIVE GUARD (b): a TERMINAL decision (resumed/superseded/failed)
      // must never have an effect dispatched or committed for it. If terminal
      // cleanup (a) was somehow missed, durably cancel any outstanding reserved
      // rows here and skip the decision entirely — reconcile is a no-op for a
      // terminal item. This guarantees no stale external effect (writeResponse/
      // resume/requeue/notify) is ever sent against a terminal decision, AND no
      // commit() is attempted (which would throw an illegal transition).
      if (TERMINAL_STATUSES.has(status)) {
        const hasLive = this.db
          .select()
          .from(outbox)
          .where(eq(outbox.decision_id, row.decision_id))
          .all()
          .some((o) => o.state !== "committed" && !o.superseded);
        if (hasLive) this.cancelReservedRows(row.decision_id);
        continue;
      }

      // (0a) CRITICAL 1 LIVE-CLAIM GUARD: if the decision has an `executing` row
      // owned by THIS live generation (not reclaimable), a runEffect is actively
      // dispatching its adapter RIGHT NOW. Reconcile must DEFER the whole decision
      // — never reclaim that row (slow-but-live adapter call) AND never fall
      // through to the state-derived expectedEffect path (which would re-derive
      // the same effect and attempt a fresh dispatch). The live runEffect owns the
      // step; reconcile is a no-op for this decision until it settles.
      const hasLiveOwnClaim = this.db
        .select()
        .from(outbox)
        .where(eq(outbox.decision_id, row.decision_id))
        .all()
        .some((o) => o.state === "executing" && !this.executingIsReclaimable(o.claimed_by, o.claimed_at));
      if (hasLiveOwnClaim) continue;

      // (0b) LIMBO GUARD (failure crash-atomicity): a NON-terminal decision whose
      // triggering outbox row is already `state="failed"` with attempts exhausted
      // is in the OLD-split crash window — the row was committed terminal but the
      // process died before the decision was marked `failed`. Reconcile MUST drive
      // the decision to `failed` (idempotently re-apply the terminal transition)
      // and MUST NOT re-derive the expected effect and re-dispatch the adapter
      // (which would `reserve()` no-op onto the failed row and `executeReserved()`
      // dispatch the external effect AGAIN after the budget was exhausted — a double
      // external effect). More generally: an effect whose outbox row is terminal/
      // exhausted is never re-dispatched. We co-commit the decision-failed mark +
      // audit + reserved cleanup atomically.
      const exhaustedFailedRow = this.db
        .select()
        .from(outbox)
        .where(eq(outbox.decision_id, row.decision_id))
        .all()
        .find((o) => o.state === "failed" && o.attempts >= this.maxAttempts);
      if (exhaustedFailedRow) {
        const failed = this.failDecisionTerminal(
          row.decision_id,
          exhaustedFailedRow.id,
          exhaustedFailedRow.last_error ?? "effect attempts exhausted",
        );
        out.push({
          decision_id: row.decision_id,
          kind: exhaustedFailedRow.kind as EffectKind,
          action: "failed",
          status: failed,
        });
        continue;
      }

      // (A) Persisted-fallback recovery (Finding 4): a reserved-but-uncommitted
      // outbox row records an effect we ALREADY reserved (and possibly executed)
      // before a crash — including a `requeue` reserved by the mid_run fallback
      // that state alone (status=source_written, resume_mode=mid_run) would NOT
      // re-derive (state would only yield `resume`). Reconcile that exact
      // reserved id by its own kind first, so we never re-dispatch a different
      // effect for the same logical step.
      // A decision may carry MULTIPLE reserved rows (e.g. a superseded `resume`
      // reservation AND the `requeue` fallback that supersedes it — Finding 4).
      // Resolve ALL reserved rows; for the fallback case prefer the row whose
      // probe is `applied` so a superseded reservation never triggers a fresh
      // redispatch. Includes notify/re_notify rows (Finding 6 crash recovery).
      // CRITICAL 1: include RECLAIMABLE `executing` rows — a crash AFTER the CAS
      // claim but BEFORE the commit txn leaves the row `executing`. OWNERSHIP is
      // the gate (executingIsReclaimable): a row owned by THIS generation is a
      // LIVE in-flight execution and is NEVER reclaimed (regardless of the lease —
      // a slow-but-live adapter call must not be re-dispatched); a row owned by a
      // DIFFERENT (prior, dead) generation whose lease expired is crash-recoverable
      // exactly like a reserved row: probe the deterministic marker — applied ->
      // commit/advance (no re-dispatch); absent -> re-claim+re-execute; unknown ->
      // fail-closed.
      const reservedRows = this.db
        .select()
        .from(outbox)
        .where(eq(outbox.decision_id, row.decision_id))
        .all()
        .filter(
          (o) =>
            (o.state === "reserved" ||
              (o.state === "executing" && this.executingIsReclaimable(o.claimed_by, o.claimed_at))) &&
            (o.kind === "resume" ||
              o.kind === "requeue" ||
              o.kind === "write_response" ||
              o.kind === "notify"),
        );
      if (reservedRows.length > 0) {
        // Supersession-aware filtering for the resume/requeue fallback pair. A
        // mid_run `resume` and its fallback `requeue` are NOT independent: the
        // fallback supersedes the resume. In the crash window BOTH can be
        // reserved+absent. Re-executing both would dispatch a mid_run wake AND a
        // restart for the same decision (or double-dispatch the fallback). So the
        // requeue is the SINGLE live recovery effect for the pair:
        //   1) the durable `superseded` marker (set when the fallback was reserved)
        //      excludes the resume row; AND
        //   2) defensively, if a reserved fallback `requeue` exists, treat any
        //      reserved `resume` for the same decision as superseded even if the
        //      marker was lost — detecting the pair at reconcile.
        // Independent kinds (notify/re_notify/write_response) are untouched.
        const hasReservedRequeue = reservedRows.some((o) => o.kind === "requeue");
        const liveRows = reservedRows.filter(
          (o) => !o.superseded && !(hasReservedRequeue && o.kind === "resume"),
        );
        const probed = await Promise.all(
          liveRows.map(async (o) => {
            const kind = o.kind as EffectKind;
            const spec = this.specFromRow(item, o.id, kind, o.intended_transition, o.semantic_key);
            return { row: o, kind, spec, probe: await this.probe(kind, spec.id) };
          }),
        );
        if (probed.length === 0) {
          // Every reserved row is a superseded resume reservation whose live
          // partner (the fallback requeue) was already resolved in a prior
          // reconcile (it is no longer `reserved`). These rows are inert evidence
          // of the superseded mid_run intent — NEVER re-dispatch them. Leave them
          // and move on; the decision has already advanced via the requeue.
          continue;
        }
        // Resolve an APPLIED reservation first: advance state, idempotent, NO
        // re-dispatch. This handles the fallback `requeue` (applied) that
        // supersedes the older `resume` reservation (absent).
        const appliedRow = probed.find((p) => p.probe === "applied");
        if (appliedRow) {
          // A4: an applied resume/requeue reservation lands DIRECTLY in terminal
          // `resumed` (atomic resume_dispatch + resume_ack); other kinds use the
          // single-transition commit. If already past dispatch (resume_requested),
          // commitResumeTerminal's resume_dispatch is an idempotent no-op.
          const newStatus =
            appliedRow.kind === "resume" || appliedRow.kind === "requeue"
              ? this.commitResumeTerminal(appliedRow.spec, row.decision_id)
              : this.commit(appliedRow.spec, row.decision_id);
          out.push({ decision_id: row.decision_id, kind: appliedRow.kind, action: "advanced", status: newStatus });
          continue;
        }
        // No applied reservation but an indeterminate one -> fail (never risk dup).
        const unknownRow = probed.find((p) => p.probe === "unknown");
        if (unknownRow) {
          const failed = this.failDecisionTerminal(
            row.decision_id,
            unknownRow.spec.id,
            `${unknownRow.kind} probe unknown`,
          );
          out.push({ decision_id: row.decision_id, kind: unknownRow.kind, action: "failed", status: failed });
          continue;
        }
        // All reserved rows probe `absent`: the effect was reserved (step 1) but
        // crashed BEFORE execute. The reserved row is itself the durable evidence
        // the effect was intended, so honour the two-phase invariant — run step 2
        // (execute) then commit it directly from its OWN spec, regardless of what
        // state-derived expectedEffect() would predict. This is the only path that
        // recovers a reserved notify/re_notify row whose status (notified/viewed)
        // yields null from expectedEffect() and would otherwise stay stuck
        // `reserved`. Re-execute every absent reservation (notify re-send is
        // idempotent/acceptable). For resume/requeue the deterministic id matches
        // the reserved row, so executeReserved re-dispatches the SAME logical step.
        const absentRows = probed.filter((p) => p.probe === "absent");
        if (absentRows.length > 0) {
          for (const a of absentRows) {
            // CRITICAL 1: if a crash left this row `executing`, release the claim
            // back to `reserved` so executeReserved's CAS claim can re-acquire it.
            if (a.row.state === "executing") this.releaseClaim(a.spec.id);
            const r = await this.executeReserved(row.decision_id, item, a.spec);
            out.push({ decision_id: row.decision_id, kind: a.kind, action: "re-executed", status: r.status });
          }
          continue;
        }
      }

      const expected = this.expectedEffect(status, item.resume_mode);
      if (!expected) continue;
      const spec = this.effectSpecFor(item, expected);
      const isResume = expected === "resume" || expected === "requeue";
      const probe = await this.probe(expected, spec.id);
      if (probe === "applied") {
        // ensure an outbox row exists so commit() is consistent, then advance.
        this.reserve(spec, row.decision_id);
        // A4: an applied resume/requeue marker drives the decision directly to
        // terminal `resumed` (atomic resume_dispatch + resume_ack). For a
        // resume_requested decision (crash after resume_dispatch), the
        // resume_dispatch apply is an idempotent no-op and only resume_ack fires.
        const newStatus = isResume
          ? this.commitResumeTerminal(spec, row.decision_id)
          : this.commit(spec, row.decision_id);
        out.push({ decision_id: row.decision_id, kind: expected, action: "advanced", status: newStatus });
      } else if (probe === "absent") {
        if (status === "resume_requested") {
          // A4: resume_dispatch already committed (status is resume_requested) but
          // the marker is absent (the dispatch crashed before reaching the worker,
          // or the worker lost it). Re-dispatch via runResume directly — the
          // public runEffect would preflight resume_dispatch from resume_requested
          // (illegal). runResume re-applies the freshness guard then dispatches;
          // on ack commitResumeTerminal's resume_dispatch no-ops + resume_ack
          // fires -> resumed.
          this.reserve(spec, row.decision_id);
          const r = await this.runResume(row.decision_id, item, spec);
          out.push({ decision_id: row.decision_id, kind: expected, action: "re-executed", status: r.status });
        } else {
          const r = await this.runEffect(row.decision_id, expected);
          out.push({ decision_id: row.decision_id, kind: expected, action: "re-executed", status: r.status });
        }
      } else {
        const failed = this.failDecisionTerminal(row.decision_id, spec.id, `${expected} probe unknown`);
        out.push({ decision_id: row.decision_id, kind: expected, action: "failed", status: failed });
      }
    }
    return out;
  }

  /** Rebuild an EffectSpec from a persisted outbox row (its id + intended_transition). */
  private specFromRow(
    item: ItemEffectRow,
    id: string,
    kind: EffectKind,
    intendedTransition: string,
    semanticKey: string | null,
  ): EffectSpec {
    // Finding I6: the transition semantic key is recovered from the persisted
    // `semantic_key` column — the source of truth — NEVER by string-splitting the
    // deterministic id. A re_notify cycle token may itself contain ':' (e.g. an
    // ISO-8601 timestamp), so a split would truncate it, producing the wrong
    // transition key and allowing a duplicate re-notify. The id keeps its string
    // form for downstream-probe determinism but is not the cycle's source of truth.
    let transitionSemanticKey: string;
    if (semanticKey !== null && semanticKey !== undefined) {
      transitionSemanticKey = semanticKey;
    } else {
      // Pre-I6 rows persisted no semantic_key. Fall back to the state-derived key.
      // For a re_notify row we cannot trust the id split (the bug); legacy rows
      // are vanishingly rare, so derive the channel-based key as the safe default.
      transitionSemanticKey =
        kind === "notify"
          ? this.channel
          : this.effectIdKey(kind, item, this.responseKey(item.decision_id));
    }
    return { kind, id, intendedTransition: intendedTransition as TransitionEvent, transitionSemanticKey };
  }

  /** Which effect is expected next, derived purely from item status + resume_mode. */
  private expectedEffect(
    status: ItemStatus,
    resumeMode: "mid_run" | "requeue",
  ): EffectKind | null {
    switch (status) {
      case "detected":
        return "notify";
      case "answered_pending_source_write":
        return "write_response";
      case "source_written":
        return resumeMode === "requeue" ? "requeue" : "resume";
      case "resume_requested":
        // A4 crash recovery: resume_dispatch committed but resume_ack didn't.
        // expectedEffect(resume_requested) = probe the requeue/resume marker —
        // marker applied -> apply resume_ack -> resumed; absent -> re-execute.
        return resumeMode === "requeue" ? "requeue" : "resume";
      default:
        return null;
    }
  }

  /**
   * IMPORTANT 2 + FINDING 2 (drive-pending sweep). Enumerate the ACTUAL pending
   * effects of NON-terminal items — each a `(decision_id, kind)` for a `reserved`
   * row whose attempts are not yet exhausted (a transient notify/write/requeue
   * failure that left the row reserved + the decision status unchanged, with no
   * follow-up because normal polling returns `unchanged` and only newly-admitted
   * items get driven). The sweep re-drives these through the single writer-driver
   * queue, dispatching THE REPORTED KIND via `runEffect(decision_id, kind)`.
   *
   * FINDING 2: returning the concrete `kind` (not just the decision_id) is the fix
   * for the mid_run->requeue fallback strand. After a mid_run resume goes
   * unreachable, the live recovery effect is the fallback `requeue`; if it fails
   * transiently the live pending row is a RESERVED `requeue` while the older
   * `resume` row is superseded. A state-derived sweep would re-derive `resume`
   * (source_written + resume_mode=mid_run), hit the superseded resume row, and
   * never retry the requeue — a strand. Reporting the reserved row's OWN kind
   * (requeue) lets the sweep retry it AS requeue -> terminal `resumed`.
   *
   * We deliberately EXCLUDE:
   *  - `executing` rows (a live in-flight effect, or a prior-gen executing row
   *    that is reconcile's province — recovered by reconcile() each tick);
   *  - `superseded`/`committed`/exhausted-`failed` rows (inert/settled);
   *  - terminal decisions (their reserved rows are inert — reconcile/terminal
   *    cleanup cancels them).
   * One entry per distinct (decision_id, kind) so a decision is never double-driven
   * for the same effect.
   */
  pendingEffectDecisions(): PendingEffect[] {
    const rows = this.db.select().from(outbox).all();
    const seen = new Set<string>();
    const pending: PendingEffect[] = [];
    for (const o of rows) {
      if (o.state !== "reserved") continue;
      if (o.superseded) continue;
      if (o.attempts >= this.maxAttempts) continue;
      // a terminal decision's reserved rows are inert (reconcile/terminal-cleanup
      // cancels them) — never report them.
      if (this.isTerminal(o.decision_id)) continue;
      const dedupKey = `${o.decision_id}|${o.kind}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      pending.push({ decision_id: o.decision_id, kind: o.kind as EffectKind });
    }
    return pending;
  }

  private async probe(kind: EffectKind, id: string): Promise<ProbeResult> {
    switch (kind) {
      case "notify":
        return await this.notifier.probe(id);
      case "write_response":
        return await this.sourceSink.exists(id);
      case "resume":
      case "requeue":
        return await this.resumeDispatcher.status(id);
    }
  }
}
