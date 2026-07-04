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

// Regression guard for the DOUBLE-DELIVERY multi-tick flake: a poll tick whose
// `onPoll` is still draining swallows the next fake-timer interval fire via
// RepoManager.startPoll's `pollInProgress` re-entrancy guard. A test that drives a
// SECOND poll tick with a single advanceTimersByTimeAsync + a passive settleRealUntil
// therefore hangs under load (the second tick is lost and never re-fired). Multi-tick
// waits must re-arm the interval until the effect lands (advancePollsUntil).
describe('double-delivery multi-tick re-fire gate (immovable)', () => {
  it('daemon.test.ts defines an advancePollsUntil helper', () => {
    expect(daemonTest).toMatch(/async function advancePollsUntil/);
  });

  it('advancePollsUntil re-advances the faked poll interval (not a passive wait)', () => {
    const body =
      daemonTest
        .split(/async function advancePollsUntil/)[1]
        ?.split(/\n}\n/)[0] ?? '';
    expect(body).toMatch(/vi\.advanceTimersByTimeAsync\(/);
  });

  it('the DOUBLE-DELIVERY test re-fires ticks via advancePollsUntil for its tick-2 guard re-read', () => {
    const body =
      daemonTest.split(/it\('DOUBLE-DELIVERY:/)[1]?.split(/\n {6}it\(/)[0] ?? '';
    expect(body).not.toBe('');
    // The tick-2 guard re-read must use the re-firing helper. Regressing to a lone
    // advance + passive settleRealUntil (the swallow-prone flaky shape) drops the
    // advancePollsUntil call bound to this label, so this positive check fails.
    expect(body).toMatch(
      /advancePollsUntil\([\s\S]*?tick2 second-poll guard re-read/,
    );
  });
});

// Regression guard for the same re-entrancy hazard as DOUBLE-DELIVERY, but on the
// crash-safe-ordering / answered-once resume-replay tests: their tick-2 waits also
// re-arm a faked poll interval to observe a second answer() call, so a passive
// settleRealUntil there is equally swallow-prone under load. Both labels must be
// bound to advancePollsUntil, and test-hygiene must be able to detect a regression
// back to a passive second-tick wait.
describe('real-PG replay tick2 re-fire gate (immovable)', () => {
  const expectLabelBoundToAdvancePollsUntil = (bodyStart: RegExp, label: string) => {
    const body = daemonTest.split(bodyStart)[1]?.split(/\n {6}it\(/)[0] ?? '';
    expect(body).not.toBe('');
    const quotedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(body).toMatch(
      new RegExp(
        `advancePollsUntil\\(\\s*\\(\\)\\s*=>\\s*answerSpy\\.mock\\.calls\\.length\\s*,\\s*\\(n\\)\\s*=>\\s*n\\s*>\\s*seen\\s*,\\s*\\{\\s*label:\\s*'${quotedLabel}'`,
      ),
    );
    expect(body).not.toMatch(
      new RegExp(
        `settleRealUntil\\(\\s*\\(\\)\\s*=>\\s*answerSpy\\.mock\\.calls\\.length\\s*,\\s*\\(n\\)\\s*=>\\s*n\\s*>\\s*seen\\s*,\\s*\\{\\s*label:\\s*'${quotedLabel}'`,
      ),
    );
  };

  it("daemon.test.ts binds 'crash-safe ordering tick2 second-poll answer re-call' to advancePollsUntil", () => {
    expectLabelBoundToAdvancePollsUntil(
      /it\('records the answer BEFORE save/,
      'crash-safe ordering tick2 second-poll answer re-call',
    );
  });

  it("daemon.test.ts binds 'answered-once tick2 second-poll answer re-call' to advancePollsUntil", () => {
    expectLabelBoundToAdvancePollsUntil(
      /it\('records the answer once when/,
      'answered-once tick2 second-poll answer re-call',
    );
  });

  it('test-hygiene.test.ts exports findSecondTickPassiveWaitViolations', () => {
    expect(hygiene).toMatch(/export function findSecondTickPassiveWaitViolations/);
  });
});
