// packages/daemon/src/session-runtime/providers/window-scheduler/regressions.test.ts
// Regression tests for adversarial-review findings (codex GPT-5.5, 2026-06-17).
// These ADD coverage the acceptance gate did not pin; the gate files are immovable.
import { describe, it, expect } from 'vitest';
import { WindowLedger } from './ledger.js';
import { classifySignal } from './classify.js';
import type { PoolConfig, QuotaSignal, SignalClass } from './types.js';

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5h

const poolA: PoolConfig = {
  name: 'pool-a',
  providers: ['p1', 'p2'],
  window: { lengthMs: WINDOW_MS, reset: 'rolling-from-first-use' },
  signalSources: ['retry-after'],
  preferenceRank: 0,
};

const signal = (overrides: Partial<QuotaSignal> = {}): QuotaSignal => ({
  providerName: 'p1',
  observedAt: 1_000,
  ...overrides,
});

describe('WindowLedger.snapshot immutability (P1)', () => {
  it('a snapshot is isolated from later in-place ledger mutations', () => {
    const ledger = new WindowLedger([poolA]);
    const before = ledger.snapshot(2_000); // taken while pool-a is still 'unknown'
    expect(before.headroom('pool-a')).toBe('unknown');

    // Mutate the ledger AFTER the snapshot was taken.
    const observedAt = 1_000;
    const classified: SignalClass = {
      kind: 'window-exhaustion',
      reopenProjection: observedAt + WINDOW_MS,
    };
    ledger.reportExhaustionSignal(signal({ observedAt, retryAfterMs: WINDOW_MS }), classified);

    // The earlier snapshot must NOT see the mutation (it captured values, not refs).
    expect(before.headroom('pool-a')).toBe('unknown');
    // A fresh snapshot does see it.
    expect(ledger.snapshot(observedAt + 1).headroom('pool-a')).toBe('exhausted');
  });
});

describe('WindowLedger reopen boundary (P2)', () => {
  it('at exactly now === reopenProjection the pool is already dispatchable (>=, not >)', () => {
    const ledger = new WindowLedger([poolA]);
    const observedAt = 1_000;
    const reopenProjection = observedAt + WINDOW_MS;
    ledger.reportExhaustionSignal(signal({ observedAt, retryAfterMs: WINDOW_MS }), {
      kind: 'window-exhaustion',
      reopenProjection,
    });
    // One tick before: still exhausted. Exactly at the projection: resumed.
    expect(ledger.snapshot(reopenProjection - 1).headroom('pool-a')).toBe('exhausted');
    expect(ledger.snapshot(reopenProjection).headroom('pool-a')).toBe('unknown');
  });
});

describe('classifySignal decisive-wording with non-positive retry-after (P2)', () => {
  it('windowWording + retryAfterMs 0 projects a full window out, not the observation instant', () => {
    const observedAt = 10_000;
    const result = classifySignal(
      { providerName: 'p1', observedAt, retryAfterMs: 0, windowWording: true },
      poolA,
    );
    expect(result.kind).toBe('window-exhaustion');
    if (result.kind === 'window-exhaustion') {
      // Must NOT be observedAt (immediate-reopen tight-loop); falls back to window length.
      expect(result.reopenProjection).toBe(observedAt + WINDOW_MS);
      expect(result.reopenProjection).not.toBe(observedAt);
    }
  });

  it('windowWording + retryAfterMs absent also falls back to the window length', () => {
    const observedAt = 10_000;
    const result = classifySignal({ providerName: 'p1', observedAt, windowWording: true }, poolA);
    expect(result.kind).toBe('window-exhaustion');
    if (result.kind === 'window-exhaustion') {
      expect(result.reopenProjection).toBe(observedAt + WINDOW_MS);
    }
  });
});
