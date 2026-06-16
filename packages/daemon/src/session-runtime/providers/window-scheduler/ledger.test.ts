// packages/daemon/src/session-runtime/providers/window-scheduler/ledger.test.ts
import { describe, it, expect } from 'vitest';
import { WindowLedger } from './ledger.js';
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

describe('WindowLedger', () => {
  it('a fresh pool (no evidence) is never ample (no-evidence → never ample; here: unknown)', () => {
    const ledger = new WindowLedger([poolA]);
    const snap = ledger.snapshot(1_000);
    const h = snap.headroom('pool-a');
    expect(h).not.toBe('ample');
    // The L3: "no evidence → never ample, stale → unknown". A fresh ledger has no
    // evidence, so we assert the unknown encoding (dispatchable, never preferred).
    expect(h).toBe('unknown');
  });

  it('after a window-exhaustion exhaustion signal, the pool snapshot headroom is exhausted', () => {
    const ledger = new WindowLedger([poolA]);
    const observedAt = 1_000;
    const reopenProjection = observedAt + WINDOW_MS;
    const classified: SignalClass = { kind: 'window-exhaustion', reopenProjection };
    ledger.reportExhaustionSignal(signal({ observedAt, retryAfterMs: WINDOW_MS }), classified);
    expect(ledger.snapshot(observedAt + 1).headroom('pool-a')).toBe('exhausted');
  });

  it('a snapshot with now past the reopen projection no longer reports exhausted (hint → dispatchable, never auto-ample)', () => {
    const ledger = new WindowLedger([poolA]);
    const observedAt = 1_000;
    const reopenProjection = observedAt + WINDOW_MS;
    const classified: SignalClass = { kind: 'window-exhaustion', reopenProjection };
    ledger.reportExhaustionSignal(signal({ observedAt, retryAfterMs: WINDOW_MS }), classified);

    const afterReopen = reopenProjection + 1;
    const h = ledger.snapshot(afterReopen).headroom('pool-a');
    expect(h).not.toBe('exhausted'); // projection passed → dispatchable again
    expect(h).not.toBe('ample'); // rebuilt from new evidence only — never auto-ample
    expect(h).toBe('unknown');
  });

  it('an unmapped provider (in no pool) is treated as its own implicit single-provider pool at unknown (no throw)', () => {
    const ledger = new WindowLedger([poolA]);
    const snap = ledger.snapshot(1_000);
    // 'ghost' is not declared in any pool — defense in depth: implicit pool, unknown.
    expect(() => snap.headroom('ghost')).not.toThrow();
    expect(snap.headroom('ghost')).toBe('unknown');
  });
});
