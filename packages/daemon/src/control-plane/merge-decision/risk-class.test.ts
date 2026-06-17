// packages/daemon/src/control-plane/merge-decision/risk-class.test.ts
//
// Exhaustive, immovable mapping of lane-engine RiskLevel → decision risk_class.
// The two vocabularies are distinct; this asserts the one true translation.
import { describe, it, expect } from 'vitest';
import { toDecisionRiskClass } from './risk-class.js';
import type { RiskLevel } from '../lane-engine/types.js';

describe('toDecisionRiskClass', () => {
  const cases: [RiskLevel, 'P0' | 'P1' | 'P2' | 'P3'][] = [
    ['red', 'P0'],
    ['orange', 'P1'],
    ['yellow', 'P2'],
    ['green', 'P3'],
  ];

  for (const [level, expected] of cases) {
    it(`maps ${level} → ${expected}`, () => {
      expect(toDecisionRiskClass(level)).toBe(expected);
    });
  }

  it('maps every RiskLevel (no level left unmapped)', () => {
    const all: RiskLevel[] = ['green', 'yellow', 'orange', 'red'];
    const mapped = all.map(toDecisionRiskClass);
    // Bijective onto the four P-classes — most cautious risk → most severe class.
    expect(new Set(mapped)).toEqual(new Set(['P0', 'P1', 'P2', 'P3']));
  });
});
