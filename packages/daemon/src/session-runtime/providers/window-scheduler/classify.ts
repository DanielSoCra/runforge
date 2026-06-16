// packages/daemon/src/session-runtime/providers/window-scheduler/classify.ts
import type { PoolConfig, QuotaSignal, SignalClass } from './types.js';

/**
 * Fraction of a pool's window length at/above which a retry-after is read as the
 * recurring window (long-horizon) rather than a momentary throttle. The
 * implementer picks the value; tests assert behavior RELATIVE to this constant.
 */
export const LONG_HORIZON_FRACTION: number = 0.5;

/**
 * The L2's central error-handling rule, as one pure classifier:
 *  - retryAfterMs ≥ window.lengthMs * LONG_HORIZON_FRACTION (or window wording)
 *      → `window-exhaustion`, reopenProjection = observedAt + (retryAfterMs ?? window.lengthMs).
 *  - short-horizon positive retryAfterMs → `provider-throttle` (per-provider cooldown,
 *      NEVER marks the pool).
 *  - retryAfterMs 0/absent → `ambiguous`.
 *
 * `ambiguous` is the cannot-decide arm: consumers MUST map it to the
 * less-disruptive provider-throttle (per-provider cooldown), never to pool
 * exhaustion. The classifier returns the `ambiguous` arm so callers own that
 * mapping (and misclassification can self-correct past the repetition threshold).
 */
export function classifySignal(sig: QuotaSignal, pool: PoolConfig): SignalClass {
  const retryAfterMs = sig.retryAfterMs;
  const longHorizonThreshold = pool.window.lengthMs * LONG_HORIZON_FRACTION;
  const isLongHorizon = retryAfterMs !== undefined && retryAfterMs >= longHorizonThreshold;

  if (isLongHorizon || sig.windowWording === true) {
    const reopenAfter = retryAfterMs ?? pool.window.lengthMs;
    return { kind: 'window-exhaustion', reopenProjection: sig.observedAt + reopenAfter };
  }

  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return { kind: 'provider-throttle', retryAfterMs };
  }

  return { kind: 'ambiguous' };
}
