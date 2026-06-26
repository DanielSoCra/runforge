/**
 * DecisionLedger — the daemon-facing facade over the real `@auto-claude/decision-index`
 * `IndexWriter`. It wraps ONLY the real verbs (`observeRequest`, `applyEvent`,
 * `runEffect`, `reconcile`, `reader`) and drives the verified §6.2 lifecycle:
 *
 *   detected --runEffect('notify')--> notified
 *           --applyEvent('answer_submitted',{answer})  (auto-opens notified->viewed)
 *           --> answered_pending_source_write
 *           --runEffect('write_response')--> source_written
 *           --runEffect('resume'|'requeue') (atomic resume_dispatch+resume_ack)--> resumed
 *
 * No invented methods or payload shapes: every event name / `AnswerPayload` /
 * `ApplyCtx` field / `EffectKind` is taken from the package's exported types.
 *
 * `IndexWriter` is a TYPE-ONLY import here (`import type`) so this module never
 * emits a runtime require of the native package — the only runtime load is the
 * manager's dynamic import inside its enabled branch.
 */
import type { IndexWriter, DecisionView, ReadModel, ProtectedStore } from '@auto-claude/decision-index';
import type { ResumeMode } from '@auto-claude/decision-protocol';

/** Terminal statuses are excluded from the pending read (mirrors TERMINAL_STATUSES). */
const TERMINAL: ReadonlySet<string> = new Set(['resumed', 'superseded', 'failed']);

/** Result of a notify attempt: `applied=false` when status-guarded to a no-op. */
export interface NotifyResult {
  applied: boolean;
  status: string;
}

/**
 * Result of an answer attempt: `applied=false` when the writer replays an
 * answered-once no-op, OR when the row is missing (`status:'unknown'`). `status`
 * is a plain string (not `ItemStatus`) precisely so a missing row has a value.
 */
export interface AnswerResult {
  applied: boolean;
  status: string;
}

export class DecisionLedger {
  constructor(private readonly writer: IndexWriter) {}

  /** The read-only projection backed by this ledger's writer. */
  get reader(): ReadModel {
    return this.writer.reader;
  }

  /** The protected store backing this ledger (used for sanitization / reveal). */
  protectedStore(): ProtectedStore {
    return this.writer.protectedStore;
  }

  /** Reveal a protected field for this decision; delegates to the writer's security-gated reveal. */
  revealProtected(decisionId: string, ref: string, actor: string): Promise<{ field: string; value: string }> {
    return this.writer.revealProtected(decisionId, ref, actor);
  }

  /**
   * raise — idempotent ingest of a DecisionRequest. A new id is admitted at
   * `detected`; a re-scan of the same request is `unchanged`; an edited request is
   * `superseded` (per the package's `observeRequest` contract). Deterministic-id
   * dedup makes repeated per-tick raises safe.
   */
  raise(rawRequest: unknown): Promise<{
    decision_id: string;
    outcome: 'admitted' | 'unchanged' | 'superseded';
  }> {
    return this.writer.observeRequest(rawRequest);
  }

  /**
   * notify — runs the `notify` effect ONLY when the item is still `detected`. The
   * real `runEffect('notify')` preflights the pure state guard and throws
   * `IllegalTransitionError` from `notified`+ (it is not a `re_notify` cycle), so
   * a per-tick re-scan that calls notify again must be status-guarded to a no-op.
   * An unknown id is also a no-op (nothing to notify).
   */
  async notify(decisionId: string): Promise<NotifyResult> {
    const view = await this.writer.reader.get(decisionId);
    if (!view) return { applied: false, status: 'unknown' };
    if (view.status !== 'detected') return { applied: false, status: view.status };
    const res = await this.writer.runEffect(decisionId, 'notify');
    return { applied: res.outcome === 'committed', status: res.status };
  }

  /**
   * answer — record the operator's chosen option. `applyEvent('answer_submitted')`
   * auto-applies `opened` (notified -> viewed) first, then advances to
   * `answered_pending_source_write`. Answered-once is enforced by the writer: a
   * second identical answer replays as a no-op (`applied=false`); a conflicting
   * one throws `AnsweredOnceConflictError`.
   *
   * MISSING-ROW GUARD (mirrors `notify`/`advanceToResumed`/`supersede`): applying
   * an event to an absent decision throws `UnknownDecisionError`. The index is an
   * ADDITIVE record — the GitHub-label requeue is the v1 source of truth for
   * resume — so a missing row (raise never landed: index broken/disabled at park,
   * now enabled at resume) must be a no-op, NOT a throw that would fail-close and
   * strand the run parked forever. Returns `{applied:false, status:'unknown'}`.
   */
  async answer(
    decisionId: string,
    chosenOption: string,
    answerer: string,
    now?: string,
  ): Promise<AnswerResult> {
    const view = await this.writer.reader.get(decisionId);
    if (!view) return { applied: false, status: 'unknown' };
    const answeredAt = now ?? new Date().toISOString();
    const res = await this.writer.applyEvent(decisionId, 'answer_submitted', {
      actor: answerer,
      // semanticKey keys the transition; the response idempotency key is its
      // natural value so a re-applied answer is deduped on the same key.
      semanticKey: `${decisionId}:answer`,
      now,
      answer: {
        response_idempotency_key: `${decisionId}:answer`,
        chosen_option: chosenOption,
        answerer,
        answered_at: answeredAt,
      },
    });
    return { applied: res.applied, status: res.status };
  }

  /**
   * advanceToResumed — drive the post-answer effect chain to terminal `resumed`:
   *   answered_pending_source_write --write_response--> source_written
   *     --(write_response follow-on effect: resume|requeue)--> resumed (atomic
   *     resume_dispatch + resume_ack).
   * We follow the outbox's own reported `effects[]` rather than guessing the next
   * effect, but for v1 the only resume kind is `requeue` (the default `mode`).
   * Never direct-apply `resume_ack` — that is illegal from this status.
   */
  async advanceToResumed(decisionId: string, mode: ResumeMode = 'requeue'): Promise<void> {
    const view = await this.writer.reader.get(decisionId);
    if (!view) return;
    if (TERMINAL.has(view.status)) return;

    // 1) write_response: answered_pending_source_write -> source_written. The
    //    result carries the follow-on resume/requeue kind in `effects`.
    let followOn = mode === 'mid_run' ? 'resume' : ('requeue' as 'resume' | 'requeue');
    if (view.status === 'answered_pending_source_write') {
      const w = await this.writer.runEffect(decisionId, 'write_response');
      if (w.effects.length > 0) followOn = w.effects[0] as 'resume' | 'requeue';
      if (TERMINAL.has(w.status)) return; // superseded/failed -> stop
    }

    // 2) resume/requeue: source_written -> resumed. The outbox commits both
    //    resume_dispatch and resume_ack atomically on a confirmed dispatch.
    const after = await this.writer.reader.get(decisionId);
    if (after && after.status === 'source_written') {
      await this.writer.runEffect(decisionId, followOn);
    }
  }

  /**
   * pending — every non-terminal decision (the "what's pending" read path). Uses
   * the read model's `list()` and filters to non-terminal statuses (there is no
   * invented `listPending` — the package exposes `list`/`listRanked`).
   */
  async pending(): Promise<DecisionView[]> {
    return (await this.writer.reader.list()).filter((d) => !TERMINAL.has(d.status));
  }

  /**
   * statusOf — the current status of a decision (incl. TERMINAL statuses like
   * `resumed`/`superseded`/`failed`), or `undefined` for a missing row. Unlike
   * `pending()` (which excludes terminal rows), this reads the raw row so the
   * resume consumer can tell "already consumed this cockpit answer" (`resumed`)
   * apart from "never answered" (`undefined`/`notified`). Keeps the writer's
   * `reader` private — callers go through this thin facade.
   */
  async statusOf(decisionId: string): Promise<string | undefined> {
    return (await this.writer.reader.get(decisionId))?.status;
  }

  /** reconcile — boot-time/periodic crash recovery; completes in-flight effects. */
  reconcile(): ReturnType<IndexWriter['reconcile']> {
    return this.writer.reconcile();
  }

  /**
   * supersede — drive the §6.2 `source_superseded` event for a decision whose
   * source went moot (its issue closed / run completed / it left the gate by
   * another path). The guard lives HERE so every caller is fail-safe:
   *   - missing row (`reader.get` -> undefined) -> SKIP (applying to a non-existent
   *     decision throws `UnknownDecisionError`).
   *   - terminal row (resumed/superseded/failed) -> SKIP (re-superseding a terminal
   *     item throws `IllegalTransitionError`).
   * `source_superseded` is legal from ANY non-terminal status (incl. `detected`),
   * but the transition table REQUIRES a concrete `ctx.superseded_by`, so we pass a
   * deterministic moot marker. Returns whether the supersede was applied.
   */
  async supersede(decisionId: string, supersededBy?: string, now?: string): Promise<boolean> {
    const view = await this.writer.reader.get(decisionId);
    if (!view) return false; // missing -> skip
    if (TERMINAL.has(view.status)) return false; // terminal -> skip
    await this.writer.applyEvent(decisionId, 'source_superseded', {
      actor: 'daemon',
      semanticKey: `${decisionId}:moot`,
      now,
      // the table requires a concrete superseded_by; a moot source has no real
      // successor id, so use a deterministic marker (recorded on the row).
      superseded_by: supersededBy ?? `${decisionId}:moot`,
    });
    return true;
  }

  /**
   * expireOverdue — mark every past-`expires_at` item that is awaiting a human
   * (`notified` or `viewed`) as stale via the §6.2 `expire` event. `expire` is
   * legal ONLY from those two states (applying it from detected /
   * answered_pending_source_write / source_written / resume_requested throws), so
   * we read `expires_at` + `status` from the dashboard ranking (the `list()`
   * `DecisionView` carries no `expires_at`) and filter to exactly those states.
   * `expire` is NON-terminal (sets `stale`; the item stays answerable). The
   * `semanticKey` is derived from `expires_at` so a re-sweep of the same overdue
   * item replays as an idempotent no-op. Returns the ids it expired.
   */
  async expireOverdue(now: Date): Promise<string[]> {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const expired: string[] = [];
    // includeSuppressed so a muted/deferred (but still notified/viewed) overdue
    // item is not silently skipped — staleness is independent of view-state.
    for (const item of await this.writer.reader.listRanked({ includeSuppressed: true })) {
      if (item.status !== 'notified' && item.status !== 'viewed') continue;
      if (item.expires_at == null || item.expires_at === '') continue;
      if (new Date(item.expires_at).getTime() > nowMs) continue; // not yet overdue
      await this.writer.applyEvent(item.decision_id, 'expire', {
        actor: 'daemon',
        // deterministic per (id, expiry) so a re-sweep is an idempotent replay.
        semanticKey: `${item.decision_id}:expire:${item.expires_at}`,
        now: nowIso,
      });
      expired.push(item.decision_id);
    }
    return expired;
  }
}
