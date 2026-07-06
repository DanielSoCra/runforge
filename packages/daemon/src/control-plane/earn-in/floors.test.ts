import { describe, it, expect } from 'vitest';
import { EARN_IN_FLOORS, FLOOR_NAMES, isAutonomousEligible } from './floors.js';

describe('EARN_IN_FLOORS', () => {
  it('matches the provisional platform constant', () => {
    expect(EARN_IN_FLOORS).toEqual({ minCleanMerges: 10, recencyWindowDays: 30, redWindowDays: 30 });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EARN_IN_FLOORS)).toBe(true);
    expect(() => {
      (EARN_IN_FLOORS as { minCleanMerges: number }).minCleanMerges = 99;
    }).toThrow();
  });
});

describe('isAutonomousEligible', () => {
  it('is true for green and yellow', () => {
    expect(isAutonomousEligible('green')).toBe(true);
    expect(isAutonomousEligible('yellow')).toBe(true);
  });

  it('is false for orange and red', () => {
    expect(isAutonomousEligible('orange')).toBe(false);
    expect(isAutonomousEligible('red')).toBe(false);
  });
});

describe('FLOOR_NAMES', () => {
  it('contains all seven names and no duplicates', () => {
    expect(FLOOR_NAMES).toHaveLength(7);
    expect(new Set(FLOOR_NAMES).size).toBe(7);
    expect(FLOOR_NAMES).toContain('bar-clean-merges-below-floor');
    expect(FLOOR_NAMES).toContain('bar-recency-below-floor');
    expect(FLOOR_NAMES).toContain('insufficient-recent-clean-merges');
    expect(FLOOR_NAMES).toContain('red-in-window');
    expect(FLOOR_NAMES).toContain('scope-not-holding');
    expect(FLOOR_NAMES).toContain('verifier-not-gated');
    expect(FLOOR_NAMES).toContain('reversible');
  });
});
