import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const daemonTest = readFileSync(join(HERE, 'control-plane', 'daemon.test.ts'), 'utf8');
const hygiene = readFileSync(join(HERE, 'test-hygiene.test.ts'), 'utf8');

describe('cockpit-settle-deflake acceptance gate (immovable)', () => {
  it('daemon.test.ts contains a settleRealUntil helper', () => {
    expect(daemonTest).toMatch(/async function settleRealUntil/);
  });

  it('real-PG resume waits are migrated, not blanket-marked', () => {
    const calls = daemonTest.match(/\bsettleRealUntil\s*\(/g)?.length ?? 0;
    expect(calls).toBeGreaterThanOrEqual(14);
  });

  it('fixed-drain-ok markers are bounded to the legitimate negatives', () => {
    const markers = daemonTest.match(/fixed-drain-ok/g)?.length ?? 0;
    expect(markers).toBeLessThanOrEqual(8);
  });

  it('RC-4 guard is exported from test-hygiene.test.ts', () => {
    expect(hygiene).toMatch(/export function findFixedDrainViolations/);
  });

  it('line-preserving sanitizer backs the guard', () => {
    expect(hygiene).toMatch(/blankStringsAndComments/);
  });
});
