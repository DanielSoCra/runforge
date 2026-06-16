// packages/daemon/src/session-runtime/providers/window-scheduler/filter-rank.test.ts
import { describe, it, expect } from 'vitest';
import { filterAndRankByWindow } from './filter-rank.js';
import type { Candidate, Headroom, LedgerSnapshot } from './types.js';

/** A pure, test-only snapshot: pool → headroom, defaulting unmapped to 'unknown'. */
function snapOf(states: Record<string, Headroom>): LedgerSnapshot {
  return {
    headroom(pool: string): Headroom {
      return states[pool] ?? 'unknown';
    },
  };
}

const c = (name: string, pool: string, preferenceRank: number): Candidate => ({
  name,
  pool,
  preferenceRank,
});

describe('filterAndRankByWindow', () => {
  it('drops every provider whose pool snapshot is exhausted and names those pools in excludePools', () => {
    const candidates = [c('a', 'pool-x', 0), c('b', 'pool-y', 0)];
    const snap = snapOf({ 'pool-x': 'exhausted', 'pool-y': 'ample' });
    const { eligible, excludePools } = filterAndRankByWindow(candidates, snap);
    expect(eligible.map((e) => e.name)).toEqual(['b']);
    expect(excludePools).toContain('pool-x');
    expect(excludePools).not.toContain('pool-y');
  });

  it('a pool exhaustion drops ALL its providers at once, including otherwise-healthy ones', () => {
    const candidates = [
      c('a1', 'pool-x', 0),
      c('a2', 'pool-x', 0), // same exhausted pool, individually healthy provider
      c('b', 'pool-y', 0),
    ];
    const snap = snapOf({ 'pool-x': 'exhausted', 'pool-y': 'tight' });
    const { eligible, excludePools } = filterAndRankByWindow(candidates, snap);
    expect(eligible.map((e) => e.name)).toEqual(['b']);
    expect(eligible.some((e) => e.pool === 'pool-x')).toBe(false);
    expect(excludePools).toContain('pool-x');
  });

  it('within the same preferenceRank, tight sinks below ample (prefers larger headroom), stable ordering', () => {
    const candidates = [
      c('t', 'pool-tight', 0),
      c('a', 'pool-ample', 0),
    ];
    const snap = snapOf({ 'pool-tight': 'tight', 'pool-ample': 'ample' });
    const { eligible } = filterAndRankByWindow(candidates, snap);
    expect(eligible.map((e) => e.name)).toEqual(['a', 't']); // ample first
  });

  it('unknown is dispatchable (not dropped) but never preferred over tight/ample', () => {
    // unknown ranks WITH tight for eligibility (kept) but BELOW it for preference.
    const candidates = [
      c('u', 'pool-unknown', 0),
      c('t', 'pool-tight', 0),
      c('a', 'pool-ample', 0),
    ];
    const snap = snapOf({
      'pool-unknown': 'unknown',
      'pool-tight': 'tight',
      'pool-ample': 'ample',
    });
    const { eligible, excludePools } = filterAndRankByWindow(candidates, snap);
    // dispatchable: none excluded
    expect(eligible).toHaveLength(3);
    expect(excludePools).toHaveLength(0);
    // preference: ample > tight > unknown
    expect(eligible.map((e) => e.name)).toEqual(['a', 't', 'u']);
  });

  it('empty eligible set when all pools exhausted (caller raises provider-unavailable)', () => {
    const candidates = [c('a', 'pool-x', 0), c('b', 'pool-y', 1)];
    const snap = snapOf({ 'pool-x': 'exhausted', 'pool-y': 'exhausted' });
    const { eligible, excludePools } = filterAndRankByWindow(candidates, snap);
    expect(eligible).toEqual([]);
    expect(excludePools).toEqual(expect.arrayContaining(['pool-x', 'pool-y']));
  });

  it('can only REMOVE/REORDER — never introduces a candidate not in the input', () => {
    const candidates = [
      c('a', 'pool-ample', 0),
      c('t', 'pool-tight', 0),
      c('x', 'pool-x', 0),
    ];
    const snap = snapOf({ 'pool-ample': 'ample', 'pool-tight': 'tight', 'pool-x': 'exhausted' });
    const { eligible } = filterAndRankByWindow(candidates, snap);
    const inputNames = new Set(candidates.map((cd) => cd.name));
    for (const e of eligible) {
      expect(inputNames.has(e.name)).toBe(true);
    }
    // every survivor is referentially one of the inputs (no fabricated candidates)
    for (const e of eligible) {
      expect(candidates).toContain(e);
    }
  });

  it('honors preferenceRank above headroom: a higher-preference pool stays ahead of a lower-preference ample pool', () => {
    // Preference rank dominates; headroom only orders WITHIN the same rank.
    const candidates = [
      c('hi', 'pool-hi', 0), // better (lower) preferenceRank, but only tight
      c('lo', 'pool-lo', 1), // worse preferenceRank, but ample
    ];
    const snap = snapOf({ 'pool-hi': 'tight', 'pool-lo': 'ample' });
    const { eligible } = filterAndRankByWindow(candidates, snap);
    expect(eligible.map((e) => e.name)).toEqual(['hi', 'lo']);
  });
});
