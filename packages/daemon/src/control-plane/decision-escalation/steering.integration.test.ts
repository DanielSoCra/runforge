/**
 * steering.integration.test.ts — IMMOVABLE v2 acceptance gate: the END-TO-END transport
 * guarantees shared by notes AND run controls (FUNC-AC-DECISION-ESCALATION §Constraints:
 * "Notes and run controls travel over the same uniform, durably-recorded transport ... with
 * the same guarantees: durably recorded before taking effect, effective exactly once, scoped
 * to the single run they address, and verified against the run state they were written
 * against — stale guidance is returned, never silently applied").
 *
 * Mirrors the v1 `lifecycle.integration.test.ts` style: construct the durable store, drive
 * the ledger through the same verb sequence the daemon will use (send → boundary deliver),
 * and assert the durable record survives a reconstruct (the daemon-restart analogue) with no
 * divergence and no double-application.
 *
 * RED until `./steering.js` exists.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SteeringLedger,
  InMemorySteeringStore,
  type SteeringRunRef,
} from './steering.js';

function runRef(overrides: Partial<SteeringRunRef> = {}): SteeringRunRef {
  return {
    runId: 'issue-42',
    generation: 1,
    phase: 'implement',
    phaseSeq: 1,
    status: 'running',
    ...overrides,
  };
}

describe('SteeringLedger transport guarantees (durable, exactly-once, scoped, verified)', () => {
  let store: InMemorySteeringStore;
  let ledger: SteeringLedger;

  beforeEach(() => {
    store = new InMemorySteeringStore();
    ledger = new SteeringLedger(store);
  });

  it('durably recorded BEFORE taking effect: a note survives reconstructing the ledger from the same store', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);
    const sent = ledger.sendNote(run.runId, {
      operator: 'operator',
      body: 'persisted',
      againstPhaseSeq: 1,
    });
    expect(sent.accepted).toBe(true);

    // Reconstruct a fresh ledger over the SAME store (daemon-restart analogue). The note
    // was durably recorded before any boundary, so the new ledger still delivers it.
    const reconstructed = new SteeringLedger(store);
    const atBoundary = reconstructed.deliverNotesAtBoundary(run.runId, {
      phaseSeq: 2,
      phase: 'review',
    });
    expect(atBoundary.delivered.map((n) => n.noteId)).toEqual([sent.noteId]);
  });

  it('effective exactly once across a reconstruct: a note already delivered is not re-delivered after restart', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);
    const sent = ledger.sendNote(run.runId, { operator: 'operator', body: 'once', againstPhaseSeq: 1 });

    const first = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 2, phase: 'review' });
    expect(first.delivered.map((n) => n.noteId)).toEqual([sent.noteId]);

    // Restart, then reach a later boundary — the delivered note must NOT re-fire.
    const reconstructed = new SteeringLedger(store);
    const after = reconstructed.deliverNotesAtBoundary(run.runId, { phaseSeq: 3, phase: 'holdout' });
    expect(after.delivered).toHaveLength(0);
  });

  it('scoped to the single run: concurrent runs each see only their own guidance at their own boundaries', () => {
    const a = runRef({ runId: 'issue-1', phaseSeq: 1 });
    const b = runRef({ runId: 'issue-2', phaseSeq: 1 });
    store.upsertRun(a);
    store.upsertRun(b);

    const noteA = ledger.sendNote(a.runId, { operator: 'operator', body: 'for A', againstPhaseSeq: 1 });
    ledger.redirect(b.runId, { operator: 'operator', direction: 'B new direction', againstPhaseSeq: 1 });

    const aBoundary = ledger.deliverNotesAtBoundary(a.runId, { phaseSeq: 2, phase: 'review' });
    const aDirective = ledger.directiveAtBoundary(a.runId, { phaseSeq: 2, phase: 'review' });
    const bBoundary = ledger.deliverNotesAtBoundary(b.runId, { phaseSeq: 2, phase: 'review' });
    const bDirective = ledger.directiveAtBoundary(b.runId, { phaseSeq: 2, phase: 'review' });

    expect(aBoundary.delivered.map((n) => n.noteId)).toEqual([noteA.noteId]);
    expect(aDirective.directive).toBe('proceed'); // A got a note, NOT B's redirect
    expect(bBoundary.delivered).toHaveLength(0); // B's redirect is a control, not a note
    expect(bDirective.directive).toBe('redirect');
    expect(bDirective.direction).toBe('B new direction');
  });

  it('never applied to a successor run: a fresh-generation run with the same runId does not inherit the prior generation\'s guidance', () => {
    // Gen 1 of issue-42 gets a note, then the run is aborted/rebuilt as gen 2 (rework).
    const gen1 = runRef({ runId: 'issue-42', generation: 1, phaseSeq: 1 });
    store.upsertRun(gen1);
    ledger.sendNote(gen1.runId, { operator: 'operator', body: 'for gen1', againstPhaseSeq: 1 });

    // The run advances to a new generation (a successor of the SAME runId).
    store.upsertRun(runRef({ runId: 'issue-42', generation: 2, phaseSeq: 1, status: 'running' }));

    // The successor generation must NOT inherit gen 1's note at its boundary.
    const atBoundary = ledger.deliverNotesAtBoundary('issue-42', {
      phaseSeq: 2,
      phase: 'review',
      generation: 2,
    });
    expect(atBoundary.delivered).toHaveLength(0);
  });

  it('verified against run-state: a note written against a now-stale phaseSeq is returned, the matching one is delivered', () => {
    const run = runRef({ phaseSeq: 3 });
    store.upsertRun(run);

    const staleNote = ledger.sendNote(run.runId, { operator: 'operator', body: 'stale', againstPhaseSeq: 1 });
    const freshNote = ledger.sendNote(run.runId, { operator: 'operator', body: 'fresh', againstPhaseSeq: 3 });

    expect(staleNote.accepted).toBe(false);
    expect(staleNote.outcome).toBe('stale');
    expect(freshNote.accepted).toBe(true);

    const atBoundary = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 4, phase: 'review' });
    expect(atBoundary.delivered.map((n) => n.body)).toEqual(['fresh']);

    // The stale note is returned to the operator, never silently applied.
    expect(ledger.returnedToOperator('operator').some((r) => r.body === 'stale')).toBe(true);
  });
});
