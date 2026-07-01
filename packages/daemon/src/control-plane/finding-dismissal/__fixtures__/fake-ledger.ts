/**
 * fake-ledger — a small deterministic ledger fake for the finding-dismissal
 * emit + apply-consumer tests. It models the REAL §6.2 status vocabulary the
 * emit gate and consumer key on (`detected` → `notified` → answered → `resumed`),
 * NOT the simplified `raised` vocabulary of the decision-escalation fake — the
 * finding emit's idempotency gate checks for `detected` specifically.
 *
 * Pure + synchronous-at-heart (Promises only for the async surface). No Postgres,
 * no GitHub, no timers — runs in local + CI. An optional shared `events` log lets
 * the consumer tests assert the DURABLE-FIRST ordering (verdict → observe →
 * answer → advanceToResumed) across the ledger, octokit, and learning fakes.
 */

const TERMINAL: ReadonlySet<string> = new Set(['resumed', 'superseded', 'failed']);

export interface FakeLedgerRow {
  decision_id: string;
  status: string;
  source_url: string;
  options: string[];
  answeredOption?: string;
  /** The STORED recommended_option (the rung-2 pre-fill hint the Operator saw), if any. */
  recommendedOption?: string;
}

/** A DecisionView-shaped subset (what the consumer reads off `pending()`). */
export interface FakeDecisionView {
  decision_id: string;
  status: string;
  source_url: string;
}

function extract(rawRequest: unknown, key: string): string {
  if (typeof rawRequest !== 'object' || rawRequest === null) return '';
  const v = (rawRequest as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

function extractOptionIds(rawRequest: unknown): string[] {
  if (typeof rawRequest !== 'object' || rawRequest === null) return [];
  const opts = (rawRequest as { options?: unknown }).options;
  if (!Array.isArray(opts)) return [];
  return opts
    .map((o) => (typeof o === 'object' && o !== null ? (o as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string');
}

export class FakeFindingLedger {
  readonly rows = new Map<string, FakeLedgerRow>();
  constructor(private readonly events?: string[]) {}

  private log(msg: string): void {
    this.events?.push(msg);
  }

  /** Seed a row at an arbitrary status (e.g. a pre-existing OPEN/answered decision). */
  seed(row: FakeLedgerRow): void {
    this.rows.set(row.decision_id, { ...row });
  }

  async raise(rawRequest: unknown): Promise<{
    decision_id: string;
    outcome: 'admitted' | 'unchanged' | 'superseded';
  }> {
    const decision_id = extract(rawRequest, 'decision_id');
    this.log(`raise:${decision_id}`);
    const existing = this.rows.get(decision_id);
    if (existing) return { decision_id, outcome: 'unchanged' };
    const rec = extract(rawRequest, 'recommended_option');
    this.rows.set(decision_id, {
      decision_id,
      status: 'detected',
      source_url: extract(rawRequest, 'source_url'),
      options: extractOptionIds(rawRequest),
      ...(rec !== '' ? { recommendedOption: rec } : {}),
    });
    return { decision_id, outcome: 'admitted' };
  }

  /** The STORED recommended_option that was raised/shown (the F1 honest value), or null. */
  async recommendedOptionOf(decisionId: string): Promise<string | null> {
    return this.rows.get(decisionId)?.recommendedOption ?? null;
  }

  async notify(decisionId: string): Promise<{ applied: boolean; status: string }> {
    const row = this.rows.get(decisionId);
    if (!row) return { applied: false, status: 'unknown' };
    if (row.status !== 'detected') return { applied: false, status: row.status };
    row.status = 'notified';
    this.log(`notify:${decisionId}`);
    return { applied: true, status: 'notified' };
  }

  async answer(
    decisionId: string,
    chosenOption: string,
    _answerer: string,
  ): Promise<{ applied: boolean; status: string }> {
    const row = this.rows.get(decisionId);
    if (!row) return { applied: false, status: 'unknown' };
    if (!row.options.includes(chosenOption)) {
      throw new Error(`off-menu answer "${chosenOption}" for ${decisionId}`);
    }
    if (TERMINAL.has(row.status)) return { applied: false, status: row.status };
    if (row.status === 'answered_pending_source_write') {
      if (row.answeredOption === chosenOption) {
        this.log(`answer-noop:${decisionId}`);
        return { applied: false, status: row.status }; // answer-once replay
      }
      throw new Error(`answer-once conflict for ${decisionId}`);
    }
    row.status = 'answered_pending_source_write';
    row.answeredOption = chosenOption;
    this.log(`answer:${decisionId}:${chosenOption}`);
    return { applied: true, status: row.status };
  }

  async statusOf(decisionId: string): Promise<string | undefined> {
    return this.rows.get(decisionId)?.status;
  }

  async advanceToResumed(decisionId: string): Promise<void> {
    const row = this.rows.get(decisionId);
    if (!row) return;
    if (TERMINAL.has(row.status)) return;
    if (row.status !== 'answered_pending_source_write') return;
    row.status = 'resumed';
    this.log(`advanceToResumed:${decisionId}`);
  }

  async supersede(decisionId: string): Promise<boolean> {
    const row = this.rows.get(decisionId);
    if (!row) return false;
    if (TERMINAL.has(row.status)) return false;
    row.status = 'superseded';
    this.log(`supersede:${decisionId}`);
    return true;
  }

  async pending(): Promise<FakeDecisionView[]> {
    return [...this.rows.values()]
      .filter((r) => !TERMINAL.has(r.status))
      .map((r) => ({ decision_id: r.decision_id, status: r.status, source_url: r.source_url }));
  }

  /**
   * reconcile — mimics the daemon's GENERIC outbox reconcile (which runs every
   * tick BEFORE the finding consumer): it drives any post-answer row
   * (`answered_pending_source_write`) to terminal `resumed` via the queued
   * `write_response`→resume effect, INDEPENDENTLY of the finding consumer. The
   * reconcile-race tests fire this between the consumer's awaited steps to prove
   * the durable-first ordering keeps verdict + observation safe even when the
   * ledger terminalizes the row out from under the consumer.
   */
  async reconcile(): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.status === 'answered_pending_source_write') {
        row.status = 'resumed';
        this.log(`reconcile-resumed:${row.decision_id}`);
      }
    }
  }
}
