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
import type {
  IndexWriter,
  ApplyResult,
  DecisionView,
} from '@auto-claude/decision-index';
import type { ResumeMode } from '@auto-claude/decision-protocol';

/** Terminal statuses are excluded from the pending read (mirrors TERMINAL_STATUSES). */
const TERMINAL: ReadonlySet<string> = new Set(['resumed', 'superseded', 'failed']);

/** Result of a notify attempt: `applied=false` when status-guarded to a no-op. */
export interface NotifyResult {
  applied: boolean;
  status: string;
}

export class DecisionLedger {
  constructor(private readonly writer: IndexWriter) {}

  /**
   * raise — idempotent ingest of a DecisionRequest. A new id is admitted at
   * `detected`; a re-scan of the same request is `unchanged`; an edited request is
   * `superseded` (per the package's `observeRequest` contract). Deterministic-id
   * dedup makes repeated per-tick raises safe.
   */
  raise(rawRequest: unknown): {
    decision_id: string;
    outcome: 'admitted' | 'unchanged' | 'superseded';
  } {
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
    const view = this.writer.reader.get(decisionId);
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
   */
  answer(decisionId: string, chosenOption: string, answerer: string, now?: string): ApplyResult {
    const answeredAt = now ?? new Date().toISOString();
    return this.writer.applyEvent(decisionId, 'answer_submitted', {
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
    const view = this.writer.reader.get(decisionId);
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
    const after = this.writer.reader.get(decisionId);
    if (after && after.status === 'source_written') {
      await this.writer.runEffect(decisionId, followOn);
    }
  }

  /**
   * pending — every non-terminal decision (the "what's pending" read path). Uses
   * the read model's `list()` and filters to non-terminal statuses (there is no
   * invented `listPending` — the package exposes `list`/`listRanked`).
   */
  pending(): DecisionView[] {
    return this.writer.reader.list().filter((d) => !TERMINAL.has(d.status));
  }

  /** reconcile — boot-time/periodic crash recovery; completes in-flight effects. */
  reconcile(): ReturnType<IndexWriter['reconcile']> {
    return this.writer.reconcile();
  }
}
