// packages/daemon/src/control-plane/lane-engine/gate-set.test.ts
//
// IMMOVABLE acceptance contract for the pure gate-set VERDICT (XCUT P2#1).
// RED at handoff: gateSetVerdict's body throws 'not implemented'. The implementer
// (Kimi) fills it; these cases pin the total-function semantics. Do NOT weaken.
import { describe, it, expect } from 'vitest';
import { gateSetVerdict } from './gate-set.js';

describe('gateSetVerdict', () => {
  it('returns true when every required gate is present in passedGates', () => {
    expect(
      gateSetVerdict(
        ['deterministic', 'spec-compliance'],
        ['deterministic', 'spec-compliance'],
      ),
    ).toBe(true);
  });

  it('returns false when a required gate is missing from passedGates (fail-closed)', () => {
    expect(
      gateSetVerdict(
        ['deterministic', 'security'],
        ['deterministic'], // security missing
      ),
    ).toBe(false);
  });

  it('returns true for an empty required set (a set that demands nothing is satisfied)', () => {
    expect(gateSetVerdict([], [])).toBe(true);
    expect(gateSetVerdict([], ['deterministic', 'holdout'])).toBe(true);
  });

  it('ignores extra passed gates beyond the required set', () => {
    expect(
      gateSetVerdict(
        ['deterministic'],
        ['deterministic', 'quality', 'security', 'holdout'],
      ),
    ).toBe(true);
  });

  it('returns false when NONE of the required gates passed', () => {
    expect(gateSetVerdict(['deterministic', 'holdout'], [])).toBe(false);
  });

  it('accepts a ReadonlySet for passedGates (membership-tested identically)', () => {
    expect(
      gateSetVerdict(['quality', 'holdout'], new Set(['quality', 'holdout', 'deterministic'])),
    ).toBe(true);
    expect(gateSetVerdict(['quality', 'holdout'], new Set(['quality']))).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const required = ['deterministic', 'quality'];
    const passed = ['deterministic', 'quality', 'security'];
    gateSetVerdict(required, passed);
    expect(required).toEqual(['deterministic', 'quality']);
    expect(passed).toEqual(['deterministic', 'quality', 'security']);
  });
});
