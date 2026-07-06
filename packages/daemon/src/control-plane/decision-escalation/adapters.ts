/**
 * v1 daemon-owned decision-escalation adapters.
 *
 * These MIRROR the decision-index package's own test fakes (`FakeNotifier`,
 * `FakeSourceSink`, `FakeResumeDispatcher`) so the two-phase outbox lifecycle
 * actually ADVANCES through the real verbs (notify -> write_response ->
 * resume/requeue -> resumed). v1 scope (S2 in the fold design): the index is the
 * durable ledger; delivery is light. The notifier logs only; the source-sink and
 * resume-dispatcher record in-memory effect ids so the outbox's deterministic-id
 * probes (`exists`/`status`/`currentEtag`) resolve and reconcile completes.
 *
 * CRITICAL — `RecordingSourceSink.currentEtag` MUST default to `{status:'equal'}`.
 * The real `runEffect('resume'|'requeue')` fail-closes on a freshness probe that
 * is not POSITIVELY `equal`: an `unknown` (or `source_changed` without a concrete
 * etag) DEFERS the effect (releases the claim, leaves the row reserved) and
 * strands the decision at `source_written`. Echoing `equal` for the expected etag
 * lets the resume/requeue dispatch and the decision reach terminal `resumed`.
 *
 * The types are imported from `@runforge/decision-index`. This is a TYPE-ONLY
 * import surface in v1: `import type` keeps it from emitting a runtime require, so
 * a disabled deployment never loads the package's native (better-sqlite3) code via
 * these adapters — only the manager's dynamic import inside the enabled branch
 * loads it.
 */
import type {
  Notifier,
  NotifyArgs,
  ProbeResult,
  SourceSink,
  WriteResponseArgs,
  WriteResult,
  CurrentEtagResult,
  ResumeDispatcher,
  ResumeArgs,
  ResumeResult,
} from '@runforge/decision-index';

/**
 * Opt-in toggle for the v1 LogNotifier's console line. OFF by default so a
 * flag-ON daemon with no real publisher wired does not spam one log line per
 * notify (verdict fix_before_flag_on / adapters.ts). Set
 * RUNFORGE_DECISION_LOG_NOTIFY=1/true/yes to surface it for debugging.
 */
const LOG_NOTIFY_ENABLED = ((): boolean => {
  const v = process.env.RUNFORGE_DECISION_LOG_NOTIFY?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
})();

/**
 * Notifier that logs only (delivery deferred to S1 — Slack/email/dashboard push).
 * `notify` records the ping and reports `sent`; `probe` reports `applied` for any
 * effect id we have already notified (idempotent re-send is acceptable). Mirrors
 * the package's `FakeNotifier` so a crash-recovery probe resolves to `applied`.
 */
export class LogNotifier implements Notifier {
  readonly calls: NotifyArgs[] = [];
  private readonly applied = new Set<string>();

  async notify(args: NotifyArgs): Promise<'sent' | 'failed'> {
    this.calls.push(args);
    // v1: log only. A real adapter would deliver here. The console line is the
    // ONLY observable effect of this stub, and a flag-ON daemon with no real
    // publisher wired would emit one line PER decision PER notify — pure log
    // noise. Gate it behind an opt-in so it is silent by default (verdict
    // fix_before_flag_on / adapters.ts LogNotifier). Set
    // RUNFORGE_DECISION_LOG_NOTIFY=1 to surface the line for debugging.
    if (LOG_NOTIFY_ENABLED) {
      console.log(
        `[decision-escalation] notify decision=${args.decision_id} channel=${args.channel} effect=${args.effectId}`,
      );
    }
    this.applied.add(args.effectId);
    return 'sent';
  }

  async probe(effectId: string): Promise<ProbeResult> {
    return this.applied.has(effectId) ? 'applied' : 'absent';
  }
}

/**
 * SourceSink that records the answer write in memory (no real source POST in v1 —
 * the GitHub label path remains the executor). `writeResponse` records + reports
 * `written`; `exists` probes the recorded effect ids; `currentEtag` defaults to
 * `equal` so the resume/requeue freshness guard passes; `markSuperseded` records.
 * Mirrors the package's `FakeSourceSink` default behaviour.
 */
export class RecordingSourceSink implements SourceSink {
  readonly calls: WriteResponseArgs[] = [];
  readonly superseded: { decision_id: string; newEtag: string }[] = [];
  private readonly applied = new Set<string>();

  async writeResponse(args: WriteResponseArgs): Promise<WriteResult> {
    this.calls.push(args);
    this.applied.add(args.effectId);
    return { status: 'written' };
  }

  async exists(effectId: string): Promise<ProbeResult> {
    return this.applied.has(effectId) ? 'applied' : 'absent';
  }

  async currentEtag(
    _sourceLocator: string,
    expectedSourceEtag?: string | null,
  ): Promise<CurrentEtagResult> {
    // ┌─ TRACKED S1 GUARD — SOURCE-FRESHNESS PROBE IS INERT IN v1 ─────────────────┐
    // │ This unconditionally returns `equal`, so outbox.runResume()'s fail-closed   │
    // │ source-freshness guard ALWAYS dispatches. Combined with build-request.ts    │
    // │ NOT setting `source_etag`, the guard is effectively DISABLED. SAFE today     │
    // │ ONLY because no real GitHub SourceSink ships (this sink records in-memory;   │
    // │ the live executor is the label/comment path).                               │
    // │ BEFORE a real SourceSink lands, this MUST be replaced by a real fetch+compare│
    // │ AND build-request.ts MUST set a concrete `source_etag` (BOTH together) — a   │
    // │ real sink with this stub or a null source_etag would SILENTLY resume on a    │
    // │ stale/tampered source. See the mirror note in build-request.ts.             │
    // │ ALSO before that real sink: a real WriteResult.failed.error MUST be          │
    // │ sanitized to a non-content operational message (outbox records it verbatim   │
    // │ into outbox.last_error + audit detail_json).                                 │
    // └──────────────────────────────────────────────────────────────────────────────┘
    return { status: 'equal', currentSourceEtag: expectedSourceEtag ?? undefined };
  }

  async markSuperseded(decision_id: string, newEtag: string): Promise<void> {
    this.superseded.push({ decision_id, newEtag });
  }
}

/**
 * ResumeDispatcher that records the resume/requeue in memory and acks it (the real
 * requeue executor is the daemon's existing GitHub-label path; this just lets the
 * ledger reach terminal `resumed`). Mirrors the package's `FakeResumeDispatcher`.
 */
export class AckResumeDispatcher implements ResumeDispatcher {
  readonly calls: ResumeArgs[] = [];
  private readonly applied = new Set<string>();

  async resume(args: ResumeArgs): Promise<ResumeResult> {
    this.calls.push(args);
    this.applied.add(args.effectId);
    return 'acked';
  }

  async status(effectId: string): Promise<ProbeResult> {
    return this.applied.has(effectId) ? 'applied' : 'absent';
  }
}
