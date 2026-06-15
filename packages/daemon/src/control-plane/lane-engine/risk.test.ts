// packages/daemon/src/control-plane/lane-engine/risk.test.ts
import { describe, it, expect } from 'vitest';
import { maxRiskLevel, applyRiskPathFloor } from './risk.js';
import type { RiskPathMap } from './types.js';

describe('maxRiskLevel', () => {
  it('returns the single level when given one', () => {
    expect(maxRiskLevel('green')).toBe('green');
  });

  it('returns the most cautious of several', () => {
    expect(maxRiskLevel('green', 'orange', 'yellow')).toBe('orange');
    expect(maxRiskLevel('yellow', 'red')).toBe('red');
  });
});

describe('applyRiskPathFloor', () => {
  const map: RiskPathMap = [
    { paths: ['migrations/**'], minLevel: 'red' },
    { paths: ['src/auth/**'], minLevel: 'orange' },
  ];

  it('raises the level when a touched path matches a floor entry', () => {
    expect(applyRiskPathFloor('green', map, ['src/auth/login.ts'], 'green')).toBe('orange');
  });

  it('takes the most cautious matched floor', () => {
    expect(applyRiskPathFloor('green', map, ['src/auth/x.ts', 'migrations/001.sql'], 'green')).toBe('red');
  });

  it('never lowers the classifier level (raise-only)', () => {
    expect(applyRiskPathFloor('red', map, ['docs/readme.md'], 'green')).toBe('red');
  });

  it('returns the classifier level when nothing matches and default is the floor', () => {
    expect(applyRiskPathFloor('yellow', map, ['docs/readme.md'], 'green')).toBe('yellow');
  });

  it('raises an unmatched path to the configured default minimum', () => {
    expect(applyRiskPathFloor('green', map, ['docs/readme.md'], 'yellow')).toBe('yellow');
  });

  it('lets a matched entry exceed the default minimum', () => {
    expect(applyRiskPathFloor('green', map, ['migrations/001.sql'], 'yellow')).toBe('red');
  });
});
