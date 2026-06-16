// packages/daemon/src/session-runtime/providers/window-scheduler/ledger.ts
import { classifySignal } from './classify.js';
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
      this.states.set(pool.name, { headroom: 'unknown' });
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
      this.states.set(providerName, { headroom: 'unknown' });
    }
  }

  private markExhausted(poolName: string, reopenProjection: number, observedAt: number): void {
    const state = this.states.get(poolName);
    if (state === undefined) {
      this.states.set(poolName, {
        headroom: 'exhausted',
        reopenProjection,
        lastObservedAt: observedAt,
      });
      return;
    }
    state.headroom = 'exhausted';
    state.reopenProjection = reopenProjection;
    state.lastObservedAt = observedAt;
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
    const states = new Map(this.states);
    return {
      headroom(pool: string): Headroom {
        const state = states.get(pool);
        if (state === undefined) {
          return 'unknown';
        }
        if (state.headroom === 'exhausted' && state.reopenProjection !== undefined) {
          if (now > state.reopenProjection) {
            return 'unknown';
          }
        }
        return state.headroom;
      },
    };
  }
}
