/**
 * steering-controls.test.ts — IMMOVABLE v2 acceptance gate for FUNC-AC-DECISION-ESCALATION
 * run controls: PAUSE / REDIRECT / ABORT (v2 §"Operator pauses / redirects / aborts a run"
 * + §"Steering never interrupts mid-thought" + the governs-direction-only constraint).
 *
 * Run controls travel the SAME `SteeringLedger` transport as notes, with the same
 * guarantees (durably recorded before taking effect, effective exactly once, scoped to the
 * one run, verified against the run-state). The control's effect is realised at the run's
 * phase boundary the same way a note is — except ABORT, which alone may cut a phase short at
 * the earliest safe point (never mid-write).
 *
 * The "effect" of a control at a boundary is reported as a `BoundaryDirective` the daemon
 * pipeline honors: `proceed` (continue normally), `hold` (PAUSE — finish phase, then hold at
 * boundary, no further work/spend), `redirect` (continue under the new direction), or
 * `abort` (stop at earliest safe point). The run-state transitions (`held`, `aborted`) are
 * recorded durably in the store.
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
    phaseSeq: 2,
    status: 'running',
    ...overrides,
  };
}

describe('SteeringLedger — PAUSE (v2)', () => {
  let store: InMemorySteeringStore;
  let ledger: SteeringLedger;

  beforeEach(() => {
    store = new InMemorySteeringStore();
    ledger = new SteeringLedger(store);
  });

  it('PAUSE: the run finishes the current phase, then HOLDS at the boundary — no further work/spend — until resume/abort, with state visibly held', () => {
    const run = runRef({ phaseSeq: 2, status: 'running' });
    store.upsertRun(run);

    const paused = ledger.pause(run.runId, { operator: 'operator', againstPhaseSeq: 2 });
    expect(paused.accepted).toBe(true);

    // Mid-phase the directive is still `proceed`: PAUSE does NOT cut the phase short.
    const mid = ledger.directiveAtBoundary(run.runId, { phaseSeq: 2, phase: 'implement' });
    expect(mid.directive).toBe('proceed');

    // At the NEXT boundary the run HOLDS (no further work/spend) and its state is visibly held.
    const atBoundary = ledger.directiveAtBoundary(run.runId, { phaseSeq: 3, phase: 'review' });
    expect(atBoundary.directive).toBe('hold');
    expect(store.getRun(run.runId)?.status).toBe('held');

    // A held run reports zero further work permitted until resume/abort.
    const stillHeld = ledger.directiveAtBoundary(run.runId, { phaseSeq: 3, phase: 'review' });
    expect(stillHeld.directive).toBe('hold');
  });

  it('PAUSE then RESUME: a resumed run proceeds again from its next boundary', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);
    ledger.pause(run.runId, { operator: 'operator', againstPhaseSeq: 1 });
    const held = ledger.directiveAtBoundary(run.runId, { phaseSeq: 2, phase: 'review' });
    expect(held.directive).toBe('hold');

    const resumed = ledger.resume(run.runId, { operator: 'operator' });
    expect(resumed.accepted).toBe(true);
    expect(store.getRun(run.runId)?.status).toBe('running');

    const proceed = ledger.directiveAtBoundary(run.runId, { phaseSeq: 3, phase: 'holdout' });
    expect(proceed.directive).toBe('proceed');
  });

  it('PAUSE is effective exactly once and is recorded', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);

    const first = ledger.pause(run.runId, { operator: 'operator', againstPhaseSeq: 1, idempotencyKey: 'p1' });
    expect(first.accepted).toBe(true);
    const dup = ledger.pause(run.runId, { operator: 'operator', againstPhaseSeq: 1, idempotencyKey: 'p1' });
    expect(dup.outcome).toBe('duplicate');

    // The control is durably recorded in the run's steering history.
    const history = ledger.controlHistory(run.runId);
    expect(history.filter((c) => c.control === 'pause')).toHaveLength(1);
  });
});

describe('SteeringLedger — REDIRECT (v2)', () => {
  let store: InMemorySteeringStore;
  let ledger: SteeringLedger;

  beforeEach(() => {
    store = new InMemorySteeringStore();
    ledger = new SteeringLedger(store);
  });

  it('REDIRECT: from the NEXT phase boundary the run continues under the new direction (recorded); prior consistent work preserved', () => {
    const run = runRef({ phaseSeq: 2, status: 'running' });
    store.upsertRun(run);

    const redirected = ledger.redirect(run.runId, {
      operator: 'operator',
      direction: 'Target the v2 schema, not v1.',
      againstPhaseSeq: 2,
    });
    expect(redirected.accepted).toBe(true);

    // Mid-phase: not spliced in — directive stays `proceed`.
    const mid = ledger.directiveAtBoundary(run.runId, { phaseSeq: 2, phase: 'implement' });
    expect(mid.directive).toBe('proceed');

    // At the next boundary: the run continues under the new direction.
    const atBoundary = ledger.directiveAtBoundary(run.runId, { phaseSeq: 3, phase: 'review' });
    expect(atBoundary.directive).toBe('redirect');
    expect(atBoundary.direction).toBe('Target the v2 schema, not v1.');

    // Prior work is PRESERVED (not discarded) — the directive never instructs a wipe.
    expect(atBoundary.discardPriorWork ?? false).toBe(false);

    // The redirection is durably recorded.
    expect(ledger.controlHistory(run.runId).some((c) => c.control === 'redirect')).toBe(true);
  });

  it('REDIRECT is verified against the run-state it was written against (stale is returned, not silently applied)', () => {
    const run = runRef({ phaseSeq: 5 });
    store.upsertRun(run);
    const stale = ledger.redirect(run.runId, {
      operator: 'operator',
      direction: 'change course',
      againstPhaseSeq: 1,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.outcome).toBe('stale');

    // No redirect directive ever surfaces from a stale control.
    const atBoundary = ledger.directiveAtBoundary(run.runId, { phaseSeq: 6, phase: 'review' });
    expect(atBoundary.directive).toBe('proceed');
  });
});

describe('SteeringLedger — ABORT (v2)', () => {
  let store: InMemorySteeringStore;
  let ledger: SteeringLedger;

  beforeEach(() => {
    store = new InMemorySteeringStore();
    ledger = new SteeringLedger(store);
  });

  it('ABORT: the run stops at the earliest safe point, no further work/spend, partial work preserved + labeled abandoned, recorded with reason', () => {
    const run = runRef({ phaseSeq: 2, status: 'running' });
    store.upsertRun(run);

    const aborted = ledger.abort(run.runId, { operator: 'operator', reason: 'superseded by other work' });
    expect(aborted.accepted).toBe(true);

    // ABORT alone may cut a phase short — but only at the EARLIEST SAFE POINT, which the
    // pipeline observes by polling for the directive. The directive is `abort` immediately
    // (it does not wait for the next boundary like pause/redirect).
    const directive = ledger.directiveAtBoundary(run.runId, { phaseSeq: 2, phase: 'implement' });
    expect(directive.directive).toBe('abort');

    const recorded = store.getRun(run.runId);
    expect(recorded?.status).toBe('aborted');
    // Partial work is preserved and LABELED abandoned (not deleted).
    expect(directive.partialWorkPreserved).toBe(true);
    expect(directive.partialWorkLabel).toBe('abandoned');

    // The abort and its reason are recorded.
    const history = ledger.controlHistory(run.runId);
    const abortEntry = history.find((c) => c.control === 'abort');
    expect(abortEntry).toBeDefined();
    expect(abortEntry?.reason).toBe('superseded by other work');
  });

  it('ABORT stops at the earliest safe point, never mid-write: the directive resolves only when the run is at a safe point', () => {
    const run = runRef({ phaseSeq: 2, status: 'running' });
    store.upsertRun(run);
    ledger.abort(run.runId, { operator: 'operator', reason: 'stop' });

    // When the run reports it is mid-write (an unsafe interruption point), the abort
    // directive is WITHHELD (`proceed`) so the in-flight write completes — never cut mid-write.
    const midWrite = ledger.directiveAtBoundary(run.runId, {
      phaseSeq: 2,
      phase: 'implement',
      safePoint: false,
    });
    expect(midWrite.directive).toBe('proceed');

    // Once the run reaches the earliest safe point, the abort takes effect.
    const safe = ledger.directiveAtBoundary(run.runId, {
      phaseSeq: 2,
      phase: 'implement',
      safePoint: true,
    });
    expect(safe.directive).toBe('abort');
  });
});

describe('SteeringLedger — steering never mid-thought; governs direction only (v2 cross-cutting)', () => {
  let store: InMemorySteeringStore;
  let ledger: SteeringLedger;

  beforeEach(() => {
    store = new InMemorySteeringStore();
    ledger = new SteeringLedger(store);
  });

  it('notes and redirects take effect ONLY at a phase boundary — never spliced mid-phase (not configurable)', () => {
    const run = runRef({ phaseSeq: 4, status: 'running' });
    store.upsertRun(run);
    ledger.sendNote(run.runId, { operator: 'operator', body: 'guidance', againstPhaseSeq: 4 });
    ledger.redirect(run.runId, { operator: 'operator', direction: 'new way', againstPhaseSeq: 4 });

    // Same phaseSeq (no boundary crossed) => nothing applies: no note delivered, proceed directive.
    const mid = ledger.directiveAtBoundary(run.runId, { phaseSeq: 4, phase: 'implement' });
    const midNotes = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 4, phase: 'implement' });
    expect(mid.directive).toBe('proceed');
    expect(midNotes.delivered).toHaveLength(0);

    // The mid-thought exclusion is not configurable: there is no option that makes the
    // ledger splice a note/redirect mid-phase. Boundary crossing is the ONLY trigger.
    const atBoundary = ledger.directiveAtBoundary(run.runId, { phaseSeq: 5, phase: 'review' });
    const boundaryNotes = ledger.deliverNotesAtBoundary(run.runId, { phaseSeq: 5, phase: 'review' });
    expect(atBoundary.directive).toBe('redirect');
    expect(boundaryNotes.delivered).toHaveLength(1);
  });

  it('a control NEVER bypasses a gate, approves a decision, merges, or widens what the run may touch', () => {
    const run = runRef({ phaseSeq: 1 });
    store.upsertRun(run);
    ledger.pause(run.runId, { operator: 'operator', againstPhaseSeq: 1 });
    ledger.resume(run.runId, { operator: 'operator' });
    ledger.redirect(run.runId, { operator: 'operator', direction: 'new', againstPhaseSeq: 1 });

    const atBoundary = ledger.directiveAtBoundary(run.runId, { phaseSeq: 2, phase: 'l2-gate' });
    // Even at a gate phase, the directive carries no authority to clear it, answer a
    // decision, merge, or expand scope — those flags are never set by steering.
    expect(atBoundary.gateBypassed ?? false).toBe(false);
    expect(atBoundary.decisionAnswered ?? false).toBe(false);
    expect(atBoundary.merged ?? false).toBe(false);
    expect(atBoundary.scopeWidened ?? false).toBe(false);
  });
});
