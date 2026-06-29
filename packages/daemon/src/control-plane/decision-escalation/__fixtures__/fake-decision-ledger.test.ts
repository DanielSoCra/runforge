import { describe, it, expect } from 'vitest';
import {
  FakeDecisionLedger,
  FakeDecisionManager,
  FakeOffMenuError,
  FakeAnsweredOnceConflictError,
  createFakeDecisionManager,
} from './fake-decision-ledger.js';

const REQ = (decisionId: string, options = ['approve', 'reject']) => ({
  decision_id: decisionId,
  options: options.map((id) => ({ id, label: id })),
});

describe('FakeDecisionLedger lifecycle invariants', () => {
  it('raise -> raised (admitted once, unchanged on re-raise)', async () => {
    const l = new FakeDecisionLedger();
    const r1 = await l.raise(REQ('d1'));
    expect(r1.outcome).toBe('admitted');
    expect(await l.statusOf('d1')).toBe('raised');
    const r2 = await l.raise(REQ('d1'));
    expect(r2.outcome).toBe('unchanged');
  });

  it('notify -> notified (only from raised; missing row = unknown; replay = status no-op)', async () => {
    const l = new FakeDecisionLedger();
    expect(await l.notify('missing')).toEqual({ applied: false, status: 'unknown' });
    await l.raise(REQ('d1'));
    expect(await l.notify('d1')).toEqual({ applied: true, status: 'notified' });
    expect(await l.statusOf('d1')).toBe('notified');
    // Re-notify from notified is a status-guarded no-op (not a throw).
    expect(await l.notify('d1')).toEqual({ applied: false, status: 'notified' });
  });

  it('answer REJECTS an off-menu choice', async () => {
    const l = new FakeDecisionLedger();
    l.seedNotified('d1', ['approve', 'reject']);
    await expect(l.answer('d1', 'maybe', 'operator')).rejects.toBeInstanceOf(
      FakeOffMenuError,
    );
    // The row is untouched by a rejected off-menu answer.
    expect(await l.statusOf('d1')).toBe('notified');
  });

  it('answer -> answered; identical re-answer is a no-op (answer-once)', async () => {
    const l = new FakeDecisionLedger();
    l.seedNotified('d1', ['approve', 'reject']);
    const a1 = await l.answer('d1', 'approve', 'operator');
    expect(a1).toEqual({ applied: true, status: 'answered' });
    expect(await l.statusOf('d1')).toBe('answered');
    // Identical re-answer: a no-op replay, not a throw.
    const a2 = await l.answer('d1', 'approve', 'operator');
    expect(a2).toEqual({ applied: false, status: 'answered' });
  });

  it('answer REJECTS a conflicting second answer (answer-once)', async () => {
    const l = new FakeDecisionLedger();
    l.seedNotified('d1', ['approve', 'reject']);
    await l.answer('d1', 'approve', 'operator');
    await expect(l.answer('d1', 'reject', 'operator')).rejects.toBeInstanceOf(
      FakeAnsweredOnceConflictError,
    );
    // Still answered with the original choice.
    expect(await l.statusOf('d1')).toBe('answered');
  });

  it('answer on a missing row is a no-op (unknown), never a throw', async () => {
    const l = new FakeDecisionLedger();
    expect(await l.answer('missing', 'approve', 'operator')).toEqual({
      applied: false,
      status: 'unknown',
    });
  });

  it('advanceToResumed -> resumed; a terminal/resumed row is unchanged', async () => {
    const l = new FakeDecisionLedger();
    l.seedNotified('d1', ['approve', 'reject']);
    await l.answer('d1', 'approve', 'operator');
    await l.advanceToResumed('d1', 'requeue');
    expect(await l.statusOf('d1')).toBe('resumed');
    // A second advance is a no-op (terminal unchanged).
    await l.advanceToResumed('d1', 'requeue');
    expect(await l.statusOf('d1')).toBe('resumed');
  });

  it('advanceToResumed from a NOT-answered row (notified/raised) does NOT reach resumed (mirrors the real ledger)', async () => {
    const l = new FakeDecisionLedger();
    // notified (never answered) -> advanceToResumed is a no-op (the real ledger
    // only reaches resumed via the post-answer write_response → resume chain).
    l.seedNotified('d1', ['approve', 'reject']);
    await l.advanceToResumed('d1', 'requeue');
    expect(await l.statusOf('d1')).toBe('notified');
    // raised (never notified/answered) -> also a no-op.
    await l.raise(REQ('d2'));
    await l.advanceToResumed('d2', 'requeue');
    expect(await l.statusOf('d2')).toBe('raised');
  });

  it('seedResumed seeds a terminal row directly (the sanctioned way to manufacture resumed)', async () => {
    const l = new FakeDecisionLedger();
    l.seedResumed('d1', ['approve', 'reject']);
    expect(await l.statusOf('d1')).toBe('resumed');
    // answer on the terminal row is an unchanged no-op (not a conflict throw).
    expect(await l.answer('d1', 'reject', 'operator')).toEqual({
      applied: false,
      status: 'resumed',
    });
  });

  it('answer on a terminal (resumed) row is an unchanged no-op (not a conflict throw)', async () => {
    const l = new FakeDecisionLedger();
    l.seedNotified('d1', ['approve', 'reject']);
    await l.answer('d1', 'approve', 'operator');
    await l.advanceToResumed('d1');
    // Even a *different* choice on a resumed row is a no-op, not a conflict.
    expect(await l.answer('d1', 'reject', 'operator')).toEqual({
      applied: false,
      status: 'resumed',
    });
  });
});

describe('FakeDecisionManager', () => {
  it('tracks the governed-only runtime-degraded marker (mark/clear) and exposes the same ledger', () => {
    const { manager, ledger } = createFakeDecisionManager();
    expect(manager.isRuntimeDegraded()).toBe(false);
    expect(manager.ledger()).toBe(ledger);

    manager.markRuntimeDegraded('postgres down');
    expect(manager.isRuntimeDegraded()).toBe(true);
    expect(manager.degradedMarks).toEqual(['postgres down']);

    manager.clearRuntimeDegraded();
    expect(manager.isRuntimeDegraded()).toBe(false);
    expect(manager.degradedClears).toBe(1);
  });

  it('default is enabled + available; overridable for fail-closed coverage', () => {
    const enabled = new FakeDecisionManager();
    expect(enabled.isEnabled()).toBe(true);
    expect(enabled.isAvailable()).toBe(true);

    const dead = new FakeDecisionManager({ enabled: true, available: false });
    expect(dead.isEnabled()).toBe(true);
    expect(dead.isAvailable()).toBe(false);
  });
});
