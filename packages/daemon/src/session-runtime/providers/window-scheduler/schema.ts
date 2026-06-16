// packages/daemon/src/session-runtime/providers/window-scheduler/schema.ts
import { z } from 'zod';
import type { PoolConfig } from './types.js';

/**
 * Per the L3. `.strict()` so a typo'd key fails activation rather than silently
 * collapsing into a default (fail-closed, exactly as the lane-engine schema).
 * `.nonempty()` providers — a pool with zero providers is unreachable config.
 * `.positive()` window length — a non-positive window is a config error.
 */
export const PoolConfigSchema = z
  .object({
    name: z.string().min(1),
    providers: z.array(z.string()).nonempty(), // every provider in exactly one pool — checked across pools
    window: z
      .object({
        lengthMs: z.number().positive(),
        reset: z.enum(['rolling-from-first-use', 'fixed-schedule']),
      })
      .strict(),
    signalSources: z
      .array(z.enum(['reported-quota', 'retry-after', 'observed-throttle']))
      .nonempty(),
    preferenceRank: z.number().int(),
  })
  .strict();

export type PoolMembershipResult =
  | { ok: true }
  | { ok: false; offenders: string[] };

/**
 * Enforce that EVERY provider mentioned across all pools belongs to EXACTLY one
 * pool. A provider mapped to zero pools (orphan) or two+ pools (double-claimed)
 * is an offender; the result names every offender. The schema validates one
 * pool's shape; this validates the cross-pool membership invariant.
 *
 * (Offenders are the provider names, deduplicated; ordering is unspecified.)
 */
export function validatePoolMembership(pools: PoolConfig[]): PoolMembershipResult {
  const counts = new Map<string, number>();
  for (const pool of pools) {
    for (const provider of pool.providers) {
      const current = counts.get(provider) ?? 0;
      counts.set(provider, current + 1);
    }
  }

  const offenders: string[] = [];
  for (const [provider, count] of counts) {
    if (count !== 1) {
      offenders.push(provider);
    }
  }

  if (offenders.length > 0) {
    return { ok: false, offenders };
  }
  return { ok: true };
}
