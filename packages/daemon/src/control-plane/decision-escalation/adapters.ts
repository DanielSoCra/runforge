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
 * The types are imported from `@auto-claude/decision-index`. This is a TYPE-ONLY
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
} from '@auto-claude/decision-index';

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
    // v1: log only. A real adapter would deliver here.
    console.log(
      `[decision-escalation] notify decision=${args.decision_id} channel=${args.channel} effect=${args.effectId}`,
    );
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
    // CRITICAL: positively confirm equal so the fail-closed resume guard dispatches
    // (an `unknown`/non-equal result defers and strands the row at source_written).
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
