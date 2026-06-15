/**
 * steering-notes.test.ts — IMMOVABLE v2 acceptance gate for FUNC-AC-DECISION-ESCALATION
 * (the operator→run NOTE direction; v2 §"Operator sends a note to a running team"
 * and the four note scenarios + the steering-never-mid-thought / governs-direction-only
 * constraints).
 *
 * This gate pins the MINIMAL v2 API surface the implementer (Kimi) must satisfy. It is
 * grounded in the v1 `DecisionLedger` facade pattern: a thin daemon-facing class over a
 * durable store that returns explicit `{accepted, outcome, reason}` results, dedupes on a
 * deterministic id, is idempotent on re-send, and fail-safe on a missing/finished run.
 *
 * The v2 transport is the **SteeringLedger** (operator→run), the reverse-direction sibling
 * of v1's `DecisionLedger` (run→operator). It travels the SAME uniform, durably-recorded
 * transport with the SAME guarantees (FUNC §Constraints): durably recorded before taking
 * effect, effective exactly once, scoped to the single run it addresses, verified against
 * the run-state it was written against.
 *
 * NOTHING here mocks the steering store: the tests drive an in-memory durable store the
 * implementer provides (`InMemorySteeringStore`) the same way the v1 lifecycle integration
 * test drives the real index — construct store → ledger → exercise the real verbs.
 *
 * The intended (not-yet-existing) module is imported with the `.js` ESM suffix below; the
 * gate is RED until that module exists.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SteeringLedger,
  InMemorySteeringStore,
  type SteeringRunRef,
  type DeliverNotesResult,
} from './steering.js';

/**
 * A run's identity for steering is (runId, generation, phase, status) — the same shape
 * the v1 control-plane claims a run by (ARCH §System Boundaries: "claims the owning run by
 * matching the run's identity and generation"). `phaseSeq` is the monotonic count of phase
 * boundaries the run has crossed; the operator writes a note against the run-state they saw
 * (a specific `phaseSeq`), and a note is verified against it.
 */
function runRef(overrides: Partial<SteeringRunRef> = {}): SteeringRunRef {
  return {
    runId: 'issue-42',
    generation: 1,
    phase: 'implement',
    phaseSeq: 3,
    status: 'running',
    ...overrides,
  };
}

describe('SteeringLedger — operator notes (v2)', () => {
  let store: InMemorySteeringStore;
  let ledger: SteeringLedger;

  beforeEach(() => {
    store = new InMemorySteeringStore();
    ledger = new SteeringLedger(store);
  });

  it('a note addressed to a run is held, then delivered at that run\'s NEXT phase boundary (never mid-phase)', () => {
    const run = runRef({ phaseSeq: 3, status: 'running' });
    store.upsertRun(run);

    const sent = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'Prefer the existing adapter pattern over a new abstraction.',
      againstPhaseSeq: 3,
    });
    expect(sent.accepted).toBe(true);
    expect(sent.noteId).toBeDefined();

    // Mid-phase: the run has NOT crossed a boundary since the note was written.
    // deliverNotesAtBoundary must hand back NOTHING — notes never splice into in-flight work.
    const midPhase: DeliverNotesResult = ledger.deliverNotesAtBoundary(run.runId, {
      phaseSeq: 3,
      phase: 'implement',
    });
    expect(midPhase.delivered).toHaveLength(0);

    // The run now reaches its NEXT phase boundary (phaseSeq advances).
    const atBoundary = ledger.deliverNotesAtBoundary(run.runId, {
      phaseSeq: 4,
      phase: 'review',
    });
    expect(atBoundary.delivered).toHaveLength(1);
    expect(atBoundary.delivered[0]?.body).toContain('existing adapter pattern');
    expect(atBoundary.delivered[0]?.noteId).toBe(sent.noteId);

    // "taken into account thereafter": the delivered note is now part of the run's
    // active steering context for every subsequent boundary read.
    expect(ledger.activeNotes(run.runId).map((n) => n.noteId)).toContain(sent.noteId);
  });

  it('a note takes effect EXACTLY ONCE: a second boundary does not re-deliver it', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);
    const sent = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'note',
      againstPhaseSeq: 1,
    });

    const first = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 2, phase: 'review' });
    expect(first.delivered.map((n) => n.noteId)).toEqual([sent.noteId]);

    // A later boundary re-reads, but the once-delivered note is NOT handed out again.
    const second = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 3, phase: 'holdout' });
    expect(second.delivered).toHaveLength(0);
  });

  it('a re-sent / duplicated note changes nothing further (idempotent on the note key)', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);

    const first = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'same note',
      againstPhaseSeq: 1,
      idempotencyKey: 'note-key-1',
    });
    expect(first.accepted).toBe(true);
    expect(first.outcome).toBe('queued');

    // Re-send under the SAME idempotency key: deduped, no second pending note.
    const resend = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'same note',
      againstPhaseSeq: 1,
      idempotencyKey: 'note-key-1',
    });
    expect(resend.accepted).toBe(true);
    expect(resend.outcome).toBe('duplicate');
    expect(resend.noteId).toBe(first.noteId);

    // Exactly one note is delivered at the boundary despite the duplicate send.
    const atBoundary = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 2, phase: 'review' });
    expect(atBoundary.delivered.map((n) => n.noteId)).toEqual([first.noteId]);
  });

  it('a note is scoped to the one run it addresses and never lands on a different run', () => {
    const target = runRef({ runId: 'issue-42', phaseSeq: 1 });
    const other = runRef({ runId: 'issue-99', phaseSeq: 1 });
    store.upsertRun(target);
    store.upsertRun(other);

    const sent = ledger.sendNote(target.runId, {
      operator: 'operator',
      body: 'only for 42',
      againstPhaseSeq: 1,
    });
    expect(sent.accepted).toBe(true);

    // The other run reaching a boundary receives NOTHING — a note never crosses runs.
    const otherBoundary = ledger.deliverNotesAtBoundary(other.runId, { phaseSeq: 2, phase: 'review' });
    expect(otherBoundary.delivered).toHaveLength(0);

    const targetBoundary = ledger.deliverNotesAtBoundary(target.runId, { phaseSeq: 2, phase: 'review' });
    expect(targetBoundary.delivered.map((n) => n.noteId)).toEqual([sent.noteId]);
  });

  it('a note is verified against the run-state it was written against; if the run moved past it, the operator is told (stale), not silently applied', () => {
    // Operator wrote the note while the run was at phaseSeq 2. By send time the run is at 5.
    const run = runRef({ phaseSeq: 5, status: 'running' });
    store.upsertRun(run);

    const sent = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'address the thing you were doing at phaseSeq 2',
      againstPhaseSeq: 2,
    });

    expect(sent.accepted).toBe(false);
    expect(sent.outcome).toBe('stale');
    expect(sent.reason).toMatch(/moved on|stale|phase/i);

    // A stale note is NOT queued — it never reaches a boundary.
    const atBoundary = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 6, phase: 'review' });
    expect(atBoundary.delivered).toHaveLength(0);
  });

  it('a note for a FINISHED / STOPPED / NONEXISTENT run is RETURNED with a reason, never discarded, never applied to a successor', () => {
    const finished = runRef({ runId: 'issue-1', status: 'completed', phaseSeq: 9 });
    const stopped = runRef({ runId: 'issue-2', status: 'aborted', phaseSeq: 4 });
    store.upsertRun(finished);
    store.upsertRun(stopped);

    const toFinished = ledger.sendNote(finished.runId, {
      operator: 'operator',
      body: 'too late',
      againstPhaseSeq: 9,
    });
    expect(toFinished.accepted).toBe(false);
    expect(toFinished.outcome).toBe('undeliverable');
    expect(toFinished.reason).toMatch(/complete|finished|stopped/i);

    const toStopped = ledger.sendNote(stopped.runId, {
      operator: 'operator',
      body: 'too late',
      againstPhaseSeq: 4,
    });
    expect(toStopped.accepted).toBe(false);
    expect(toStopped.outcome).toBe('undeliverable');

    const toNonexistent = ledger.sendNote('issue-does-not-exist', {
      operator: 'operator',
      body: 'no run here',
      againstPhaseSeq: 1,
    });
    expect(toNonexistent.accepted).toBe(false);
    expect(toNonexistent.outcome).toBe('not-found');
    expect(toNonexistent.reason).toMatch(/not.?found|no run|exist/i);

    // None of these were queued anywhere — never applied to a successor run.
    expect(ledger.activeNotes(finished.runId)).toHaveLength(0);
    expect(ledger.activeNotes(stopped.runId)).toHaveLength(0);
  });

  it('an undeliverable note is durably recorded as returned (not silently dropped)', () => {
    const finished = runRef({ runId: 'issue-7', status: 'completed', phaseSeq: 3 });
    store.upsertRun(finished);

    const sent = ledger.sendNote(finished.runId, {
      operator: 'operator',
      body: 'returned to sender',
      againstPhaseSeq: 3,
    });
    expect(sent.accepted).toBe(false);

    // The returned guidance is recorded for the operator (a return receipt), not vanished.
    const returned = ledger.returnedToOperator('operator');
    expect(returned.some((r) => r.runId === finished.runId && r.body === 'returned to sender')).toBe(true);
  });

  it('steering governs direction only: a note never bypasses a gate / approves a decision / widens scope', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);

    const sent = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'just guidance',
      againstPhaseSeq: 1,
    });
    const atBoundary = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 2, phase: 'review' });
    const delivered = atBoundary.delivered[0];

    expect(delivered?.noteId).toBe(sent.noteId);
    // A delivered note carries advisory guidance ONLY — it never carries a decision
    // answer, a gate-bypass authority, or a scope expansion. The kind is the boundary.
    expect(delivered?.kind).toBe('note');
    // The boundary delivery NEVER reports a gate cleared / decision answered / scope widened.
    expect(atBoundary.gateBypassed ?? false).toBe(false);
    expect(atBoundary.decisionAnswered ?? false).toBe(false);
    expect(atBoundary.scopeWidened ?? false).toBe(false);
  });
});
