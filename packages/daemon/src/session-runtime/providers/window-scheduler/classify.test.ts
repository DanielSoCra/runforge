// packages/daemon/src/session-runtime/providers/window-scheduler/classify.test.ts
import { describe, it, expect } from 'vitest';
import { LONG_HORIZON_FRACTION, classifySignal } from './classify.js';
import type { PoolConfig, QuotaSignal } from './types.js';

const pool: PoolConfig = {
  name: 'sub-a',
  providers: ['p1'],
  window: { lengthMs: 5 * 60 * 60 * 1000, reset: 'rolling-from-first-use' }, // 5h window
  signalSources: ['retry-after'],
  preferenceRank: 0,
};

const at = (retryAfterMs: number | undefined, observedAt = 1_000): QuotaSignal => ({
  providerName: 'p1',
  retryAfterMs,
  observedAt,
});

describe('classifySignal', () => {
  it('long-horizon retry-after (>= window.lengthMs * LONG_HORIZON_FRACTION) → window-exhaustion with reopenProjection = observedAt + retryAfter', () => {
    // Use a retry-after at the long-horizon boundary derived from the exported
    // constant (never a hardcoded ms value).
    const retryAfterMs = Math.ceil(pool.window.lengthMs * LONG_HORIZON_FRACTION);
    const observedAt = 10_000;
    const result = classifySignal(at(retryAfterMs, observedAt), pool);
    expect(result.kind).toBe('window-exhaustion');
    if (result.kind === 'window-exhaustion') {
      expect(result.reopenProjection).toBe(observedAt + retryAfterMs);
    }
  });

  it('short-horizon positive retry-after → provider-throttle (stays provider cooldown, NOT pool exhaustion)', () => {
    // Strictly below the long-horizon boundary, but positive.
    const retryAfterMs = Math.floor(pool.window.lengthMs * LONG_HORIZON_FRACTION) - 1;
    expect(retryAfterMs).toBeGreaterThan(0); // guard: boundary leaves a positive short-horizon band
    const result = classifySignal(at(retryAfterMs), pool);
    expect(result.kind).toBe('provider-throttle');
    if (result.kind === 'provider-throttle') {
      expect(result.retryAfterMs).toBe(retryAfterMs);
    }
  });

  it('retryAfterMs = 0 → ambiguous', () => {
    expect(classifySignal(at(0), pool).kind).toBe('ambiguous');
  });

  it('retryAfterMs absent → ambiguous', () => {
    expect(classifySignal(at(undefined), pool).kind).toBe('ambiguous');
  });

  it('returns the ambiguous arm so callers can map it to the less-disruptive throttle', () => {
    // The classifier itself returns `ambiguous`; CONSUMERS map ambiguous →
    // provider-throttle (the less-disruptive interpretation). We assert the
    // classifier surfaces the distinct arm rather than pre-collapsing it to
    // throttle, so a consumer can also drive misclassification self-correction.
    const result = classifySignal(at(0), pool);
    expect(result.kind).toBe('ambiguous');
    expect(result.kind).not.toBe('window-exhaustion'); // never pool exhaustion on ambiguous
  });
});
