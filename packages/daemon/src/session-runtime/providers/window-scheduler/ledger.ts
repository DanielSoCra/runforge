// packages/daemon/src/session-runtime/providers/window-scheduler/ledger.ts
import { classifySignal } from './classify.js';
import { headroomFromEstimate } from './headroom.js';
import type {
  Headroom,
  LedgerSnapshot,
  PoolConfig,
  QuotaSignal,
  SignalClass,
} from './types.js';

interface PoolState {
  headroom: Headroom;
  reopenProjection?: number;
  lastObservedAt?: number;
  throttleCount: number;
}

/**
 * Holds mutable observed per-pool state (consumption estimates, last signal,
 * projected reopen). Every DECISION over it is a pure function of an immutable
 * `snapshot(now)` — the ledger is the only stateful, I/O-edge component here.
 *
 * Construction takes the validated pool configs so `snapshot` knows pool
 * membership; an unmapped provider is its own implicit single-provider pool at
 * `unknown` (defense in depth, never a throw).
 */
export class WindowLedger {
  private readonly pools: readonly PoolConfig[];
  private readonly states = new Map<string, PoolState>();

  constructor(pools: readonly PoolConfig[]) {
    this.pools = pools;
    for (const pool of pools) {
      this.states.set(pool.name, { headroom: 'unknown', throttleCount: 0 });
    }
  }

  private findPoolName(providerName: string): string | undefined {
    for (const pool of this.pools) {
      if (pool.providers.includes(providerName)) {
        return pool.name;
      }
    }
    return undefined;
  }

  private ensureImplicitPool(providerName: string): void {
    if (!this.states.has(providerName)) {
      this.states.set(providerName, { headroom: 'unknown', throttleCount: 0 });
    }
  }

  private resetThrottleCount(poolName: string): void {
    const state = this.states.get(poolName);
    if (state === undefined) {
      return;
    }
    state.throttleCount = 0;
  }

  private markExhausted(poolName: string, reopenProjection: number | undefined, observedAt: number): void {
    const state = this.states.get(poolName);
    if (state === undefined) {
      this.states.set(poolName, {
        headroom: 'exhausted',
        reopenProjection,
        lastObservedAt: observedAt,
        throttleCount: 0,
      });
      return;
    }
    state.headroom = 'exhausted';
    state.reopenProjection = reopenProjection;
    state.lastObservedAt = observedAt;
    state.throttleCount = 0;
  }

  /**
   * Record one session's consumption against its pool's window and update the
   * headroom estimate. Quota signals (if any) enter here at the runtime edge.
   */
  reportConsumption(signal: QuotaSignal, classified?: SignalClass): void {
    const poolName = this.findPoolName(signal.providerName);
    if (poolName === undefined) {
      this.ensureImplicitPool(signal.providerName);
      return;
    }

    const pool = this.pools.find((p) => p.name === poolName);
    if (pool === undefined) {
      return;
    }

    const cls = classified ?? classifySignal(signal, pool);
    if (cls.kind === 'window-exhaustion') {
      this.markExhausted(poolName, cls.reopenProjection, signal.observedAt);
      return;
    }

    const state = this.states.get(poolName);
    if (state === undefined) {
      return;
    }
    state.lastObservedAt = signal.observedAt;

    // Plan-2 (silent-pool estimate→headroom): derive from the estimate when the
    // pool declares a capacity and the signal is not direct headroom evidence.
    if (pool.capacity !== undefined && signal.estimate !== undefined) {
      const derived = headroomFromEstimate(signal.estimate, pool.capacity, false);
      state.headroom = derived;
      // A derived estimate is a consumption observation, not a throttle: reset.
      this.resetThrottleCount(poolName);
    }

    // Plan-2 (repeated-throttle self-correction): count ambiguous throttles on
    // a pool that is not yet exhausted; escalate once the configured threshold
    // is reached. Any clean signal (short-horizon provider-throttle, estimate, or
    // window-exhaustion) resets the counter. An estimate-bearing report is a
    // CONSUMPTION observation, never a throttle — exclude it explicitly, else on a
    // pool declaring BOTH capacity and threshold a clean silent-pool estimate
    // (which classifySignal also labels `ambiguous`, lacking a retry-after) would
    // be miscounted as a throttle and falsely exhaust the pool after `threshold`
    // clean reports.
    if (pool.threshold !== undefined) {
      if (cls.kind === 'ambiguous' && signal.estimate === undefined) {
        if (state.headroom !== 'exhausted') {
          state.throttleCount += 1;
          if (state.throttleCount >= pool.threshold) {
            // Self-correct to exhausted with no reopen projection (pure policy
            // escalation). It behaves like other exhausted states in the snapshot.
            state.headroom = 'exhausted';
            state.reopenProjection = undefined;
            state.throttleCount = 0;
          }
        }
      } else {
        this.resetThrottleCount(poolName);
      }
    }
  }

  /**
   * Record an exhaustion signal. When classified as `window-exhaustion`, marks
   * the pool exhausted with the projected reopen and leaves all other pools
   * untouched. A `provider-throttle`/`ambiguous` classification must NOT mark the
   * pool (it stays per-provider cooldown in the registry).
   */
  reportExhaustionSignal(signal: QuotaSignal, classified: SignalClass): void {
    if (classified.kind !== 'window-exhaustion') {
      return;
    }

    const poolName = this.findPoolName(signal.providerName);
    if (poolName === undefined) {
      this.ensureImplicitPool(signal.providerName);
      this.markExhausted(signal.providerName, classified.reopenProjection, signal.observedAt);
      return;
    }

    this.markExhausted(poolName, classified.reopenProjection, signal.observedAt);
  }

  /**
   * Yield an immutable view of pool headroom evaluated at `now`. Pure decisions
   * read this; the ledger never exposes its mutable internals. Past a pool's
   * projected reopen the snapshot no longer reports `exhausted` (the projection is
   * a hint), degrading to `unknown` — never auto-`ample` without new evidence.
   */
  snapshot(now: number): LedgerSnapshot {
    // Eagerly resolve an IMMUTABLE view: copy each pool's headroom VALUE (not the
    // PoolState object reference) into a fresh map, applying the reopen projection
    // at `now`. Copying values — not references — is what isolates the snapshot
    // from later in-place markExhausted() mutations of the ledger's own PoolState
    // objects (a shallow Map copy would share them and let mutations bleed back).
    const resolved = new Map<string, Headroom>();
    // Project the still-exhausted pools' reopen times so the snapshot can answer
    // `reopenProjection(pool)` for the all-exhausted reopen hint (Plan-2). A pool
    // whose projection has passed is no longer exhausted in `resolved`, so its
    // projection is intentionally omitted (it is dispatchable again).
    const reopenProjections = new Map<string, number>();
    for (const [name, state] of this.states) {
      // Reopen is a hint, not a gate: once `now` reaches the projection the pool is
      // dispatchable again as 'unknown' (rebuilt from new evidence only — never
      // auto-'ample'). `>=` so it resumes AT the projected reopen, not one tick later.
      const reopened =
        state.headroom === 'exhausted' &&
        state.reopenProjection !== undefined &&
        now >= state.reopenProjection;
      resolved.set(name, reopened ? 'unknown' : state.headroom);
      if (state.headroom === 'exhausted' && state.reopenProjection !== undefined && !reopened) {
        reopenProjections.set(name, state.reopenProjection);
      }
    }
    return {
      headroom(pool: string): Headroom {
        return resolved.get(pool) ?? 'unknown';
      },
      reopenProjection(pool: string): number | undefined {
        return reopenProjections.get(pool);
      },
    };
  }
}
