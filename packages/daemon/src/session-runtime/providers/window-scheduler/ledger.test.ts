// packages/daemon/src/session-runtime/providers/window-scheduler/ledger.test.ts
import { describe, it, expect } from 'vitest';
import { WindowLedger } from './ledger.js';
import { TIGHT_FRACTION } from './headroom.js';
import type { PoolConfig, QuotaSignal, SignalClass } from './types.js';

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5h
const CAPACITY = 1000;

const poolA: PoolConfig = {
  name: 'pool-a',
  providers: ['p1', 'p2'],
  window: { lengthMs: WINDOW_MS, reset: 'rolling-from-first-use' },
  signalSources: ['retry-after'],
  preferenceRank: 0,
};

/** A silent pool with a declared historical capacity (estimate→headroom cap). */
const poolWithCapacity: PoolConfig = { ...poolA, capacity: CAPACITY };

/** A pool with a repeated-throttle self-correction threshold. */
const THRESHOLD = 3;
const poolWithThreshold: PoolConfig = { ...poolA, threshold: THRESHOLD };

const signal = (overrides: Partial<QuotaSignal> = {}): QuotaSignal => ({
  providerName: 'p1',
  observedAt: 1_000,
  ...overrides,
});

/** An ambiguous throttle (retryAfterMs 0/absent → classifySignal returns ambiguous). */
const ambiguous = (observedAt: number): QuotaSignal =>
  signal({ observedAt, retryAfterMs: 0 });

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

// === Plan-2 GATE TESTS (RED until Kimi implements the behaviors) =============

describe('WindowLedger silent-pool estimate→headroom (Plan-2)', () => {
  it('an estimate at/above TIGHT_FRACTION*capacity (still below capacity) caps the snapshot at tight', () => {
    const ledger = new WindowLedger([poolWithCapacity]);
    // Derive the estimate RELATIVE to the exported constant — no hardcoded number.
    const atFractionEstimate = Math.ceil(CAPACITY * TIGHT_FRACTION); // >= cap*frac, < capacity
    expect(atFractionEstimate).toBeLessThan(CAPACITY); // guard: still below full capacity
    ledger.reportConsumption(signal({ observedAt: 1_000, estimate: atFractionEstimate }));
    // Silent pool (no direct headroom evidence): headroom is capped at tight.
    expect(ledger.snapshot(2_000).headroom('pool-a')).toBe('tight');
  });

  it('an estimate at/above capacity drives the snapshot to exhausted', () => {
    const ledger = new WindowLedger([poolWithCapacity]);
    ledger.reportConsumption(signal({ observedAt: 1_000, estimate: CAPACITY }));
    expect(ledger.snapshot(2_000).headroom('pool-a')).toBe('exhausted');
  });

  it('a silent estimate below the cap is NEVER reported as ample (no-evidence → never ample)', () => {
    const ledger = new WindowLedger([poolWithCapacity]);
    const belowEstimate = Math.floor(CAPACITY * TIGHT_FRACTION) - 1; // < cap*frac
    expect(belowEstimate).toBeGreaterThanOrEqual(0);
    ledger.reportConsumption(signal({ observedAt: 1_000, estimate: belowEstimate }));
    expect(ledger.snapshot(2_000).headroom('pool-a')).not.toBe('ample');
  });

  it('with capacity ABSENT, an estimate-only consumption leaves Plan-1 headroom unchanged (unknown)', () => {
    const ledger = new WindowLedger([poolA]); // no capacity declared
    // Even a huge estimate must not derive headroom when capacity is absent (feature inert).
    ledger.reportConsumption(signal({ observedAt: 1_000, estimate: 10 * CAPACITY }));
    expect(ledger.snapshot(2_000).headroom('pool-a')).toBe('unknown');
  });

  it('an estimate at/above capacity exhausts even after a PRIOR, now-passed reopen projection (codex r2)', () => {
    const ledger = new WindowLedger([poolWithCapacity]);
    // The pool was exhausted earlier with a reopen projection at t=1_000.
    ledger.reportExhaustionSignal(signal({ observedAt: 500, retryAfterMs: 500 }), {
      kind: 'window-exhaustion',
      reopenProjection: 1_000,
    });
    // Later, a silent estimate at capacity re-derives exhausted. The STALE (passed)
    // projection must be cleared so snapshot() does not treat the pool as reopened.
    ledger.reportConsumption(signal({ observedAt: 2_000, estimate: CAPACITY }));
    // now (3_000) is past the OLD projection (1_000); without the clear this would
    // wrongly degrade to 'unknown' (dispatchable).
    expect(ledger.snapshot(3_000).headroom('pool-a')).toBe('exhausted');
  });
});

describe('WindowLedger repeated-throttle self-correction (Plan-2)', () => {
  it('threshold consecutive ambiguous throttles on a pool escalate it to exhausted in the snapshot', () => {
    const ledger = new WindowLedger([poolWithThreshold]);
    for (let i = 0; i < THRESHOLD; i += 1) {
      ledger.reportConsumption(ambiguous(1_000 + i));
    }
    expect(ledger.snapshot(2_000).headroom('pool-a')).toBe('exhausted');
  });

  it('threshold-1 consecutive ambiguous throttles do NOT escalate (still not exhausted)', () => {
    const ledger = new WindowLedger([poolWithThreshold]);
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      ledger.reportConsumption(ambiguous(1_000 + i));
    }
    expect(ledger.snapshot(2_000).headroom('pool-a')).not.toBe('exhausted');
  });

  it('a clean (non-throttle) signal resets the consecutive-throttle counter', () => {
    const ledger = new WindowLedger([poolWithThreshold]);
    // One short of escalation...
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      ledger.reportConsumption(ambiguous(1_000 + i));
    }
    // ...then a clean positive (short-horizon) consumption signal resets the counter.
    ledger.reportConsumption(signal({ observedAt: 1_500, retryAfterMs: 1 }));
    // One more ambiguous throttle is now only the FIRST of a new run → no escalation.
    ledger.reportConsumption(ambiguous(2_000));
    expect(ledger.snapshot(3_000).headroom('pool-a')).not.toBe('exhausted');
  });

  it('with threshold ABSENT, repeated ambiguous throttles NEVER auto-escalate (Plan-1)', () => {
    const ledger = new WindowLedger([poolA]); // no threshold declared
    for (let i = 0; i < 10; i += 1) {
      ledger.reportConsumption(ambiguous(1_000 + i));
    }
    expect(ledger.snapshot(2_000).headroom('pool-a')).not.toBe('exhausted');
  });

  it('on a pool declaring BOTH capacity and threshold, repeated CLEAN estimate reports below capacity do NOT self-escalate (codex r1)', () => {
    // Regression: a silent-pool estimate carries no retry-after, so classifySignal
    // labels it `ambiguous` — but it is a clean consumption observation, not a
    // throttle. It must reset (never increment) the throttle counter, else a pool
    // with both options falsely exhausts after `threshold` clean reports.
    const poolBoth: PoolConfig = { ...poolA, capacity: CAPACITY, threshold: THRESHOLD };
    const ledger = new WindowLedger([poolBoth]);
    const belowEstimate = TIGHT_FRACTION * CAPACITY - 1;
    for (let i = 0; i < THRESHOLD + 2; i += 1) {
      ledger.reportConsumption(signal({ observedAt: 1_000 + i, estimate: belowEstimate }));
    }
    // Never escalated to exhausted by the throttle counter (estimate is clean), and
    // a below-cap estimate with no evidence is capped at tight (never ample).
    expect(ledger.snapshot(2_000).headroom('pool-a')).toBe('tight');
  });
});
