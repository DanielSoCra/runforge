import { describe, it, expect } from 'vitest';
import { evaluateHealth, type HealthSignals } from './health.js';

function base(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    isGoverned: false,
    indexRuntimeDegraded: false,
    indexEnabledButUnavailable: false,
    paused: false,
    pauseReason: null,
    draining: false,
    consecutiveStuckCount: 0,
    maxConsecutiveStuck: 30,
    watchdogStalled: false,
    repoTickStale: false,
    startupDegradedRetrying: false,
    alertChannelDegraded: false,
    transientAlertFailure: false,
    ...over,
  };
}

describe('evaluateHealth — 200 ok', () => {
  it('normal operation → 200 ok', () => {
    expect(evaluateHealth(base())).toEqual({
      ok: true,
      degraded: false,
      reason: null,
    });
  });

  it('non-governed daemon with the index disabled/unavailable stays 200 ok', () => {
    const r = evaluateHealth(
      base({
        isGoverned: false,
        indexEnabledButUnavailable: true,
        indexRuntimeDegraded: true,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(false);
  });
});

describe('evaluateHealth — 503 (unsafe / no-progress)', () => {
  it('consecutiveStuckCount reaching maxConsecutiveStuck → 503', () => {
    const r = evaluateHealth(
      base({ consecutiveStuckCount: 30, maxConsecutiveStuck: 30 }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('stuck');
  });

  it('watchdog stall → 503', () => {
    const r = evaluateHealth(base({ watchdogStalled: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('watchdog');
  });

  it('governed daemon with runtime-degraded index → 503', () => {
    const r = evaluateHealth(
      base({ isGoverned: true, indexRuntimeDegraded: true }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('decision-index');
  });

  it('governed daemon with enabled-but-unavailable index → 503', () => {
    const r = evaluateHealth(
      base({ isGoverned: true, indexEnabledButUnavailable: true }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('decision-index');
  });

  it('repo tick stale while not paused/draining → 503', () => {
    const r = evaluateHealth(base({ repoTickStale: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('tick');
  });

  it('repo tick stale is suppressed while paused (intentional) ', () => {
    const r = evaluateHealth(
      base({ repoTickStale: true, paused: true, pauseReason: 'manual' }),
    );
    // paused-manual → 200 degraded, NOT a stale-tick 503
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('safety pause (budget) → 503', () => {
    const r = evaluateHealth(base({ paused: true, pauseReason: 'budget' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('budget');
  });

  it('safety pause (stuck) → 503', () => {
    const r = evaluateHealth(base({ paused: true, pauseReason: 'stuck' }));
    expect(r.ok).toBe(false);
  });

  it('safety pause (tick-error) → 503', () => {
    const r = evaluateHealth(base({ paused: true, pauseReason: 'tick-error' }));
    expect(r.ok).toBe(false);
  });

  it('safety pause (runtime-source) → 503', () => {
    const r = evaluateHealth(
      base({ paused: true, pauseReason: 'runtime-source' }),
    );
    expect(r.ok).toBe(false);
  });

  it('an UNTAGGED pause defaults to the cautious safety interpretation → 503', () => {
    const r = evaluateHealth(base({ paused: true, pauseReason: null }));
    expect(r.ok).toBe(false);
  });
});

describe('evaluateHealth — 200 degraded:true', () => {
  it('manual pause → 200 degraded (intentional, not unhealthy)', () => {
    const r = evaluateHealth(base({ paused: true, pauseReason: 'manual' }));
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('manual');
  });

  it('draining → 200 degraded', () => {
    const r = evaluateHealth(base({ draining: true }));
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('drain');
  });

  it('startup-degraded retrying → 200 degraded', () => {
    const r = evaluateHealth(base({ startupDegradedRetrying: true }));
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('governed-without-alert-channel (B2) → 200 degraded', () => {
    const r = evaluateHealth(
      base({ isGoverned: true, alertChannelDegraded: true }),
    );
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('alert-channel');
  });

  it('transient alert-channel send failure → 200 degraded', () => {
    const r = evaluateHealth(base({ transientAlertFailure: true }));
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
  });
});

describe('evaluateHealth — precedence', () => {
  it('a safety 503 condition wins over a concurrent degraded condition', () => {
    const r = evaluateHealth(
      base({
        watchdogStalled: true,
        alertChannelDegraded: true,
        draining: true,
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('manual pause distinguished from a safety pause (the headline mapping)', () => {
    const manual = evaluateHealth(base({ paused: true, pauseReason: 'manual' }));
    const safety = evaluateHealth(base({ paused: true, pauseReason: 'stuck' }));
    expect(manual.ok).toBe(true);
    expect(safety.ok).toBe(false);
  });
});
