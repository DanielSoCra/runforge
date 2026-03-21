// src/session-runtime/rate-limiter.test.ts
import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('starts with clear state', () => {
    const rl = new RateLimiter();
    const check = rl.checkRateLimit();
    expect(check.clear).toBe(true);
    expect(rl.getConsecutiveCount()).toBe(0);
  });

  it('enters cooldown after reportRateLimit', () => {
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxBackoffMs: 60000 });
    const now = 1000000;
    rl.reportRateLimit(undefined, now);

    const check = rl.checkRateLimit(now + 1000);
    expect(check.clear).toBe(false);
    if (!check.clear) {
      expect(check.remainingMs).toBe(4000);
    }
    expect(rl.getConsecutiveCount()).toBe(1);
  });

  it('uses retry-after duration when provided', () => {
    const rl = new RateLimiter();
    const now = 1000000;
    rl.reportRateLimit(10000, now); // 10s retry-after

    const check = rl.checkRateLimit(now + 5000);
    expect(check.clear).toBe(false);
    if (!check.clear) {
      expect(check.remainingMs).toBe(5000);
    }
  });

  it('clears after cooldown expires', () => {
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxBackoffMs: 60000 });
    const now = 1000000;
    rl.reportRateLimit(undefined, now);

    // After 5 seconds, should be clear
    const check = rl.checkRateLimit(now + 5001);
    expect(check.clear).toBe(true);
    expect(rl.getConsecutiveCount()).toBe(0);
  });

  it('escalates backoff on consecutive signals (without clearing)', () => {
    const rl = new RateLimiter({ baseBackoffMs: 1000, maxBackoffMs: 10000 });
    const now = 1000000;

    // First report: 1000ms backoff
    rl.reportRateLimit(undefined, now);
    expect(rl.getCooldownUntil()).toBe(now + 1000);

    // Second report before expiry: 2000ms backoff (escalated)
    rl.reportRateLimit(undefined, now + 500);
    expect(rl.getCooldownUntil()).toBe(now + 500 + 2000);

    // Third report: 4000ms backoff (escalated again)
    rl.reportRateLimit(undefined, now + 1000);
    expect(rl.getCooldownUntil()).toBe(now + 1000 + 4000);
  });

  it('caps backoff at maxBackoffMs', () => {
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxBackoffMs: 10000 });
    const now = 1000000;

    // 5000 → 10000 → capped at 10000
    rl.reportRateLimit(undefined, now);
    rl.reportRateLimit(undefined, now + 6000);
    rl.reportRateLimit(undefined, now + 20000);

    // Third backoff should be capped at 10000, not 20000
    expect(rl.getCooldownUntil()).toBe(now + 20000 + 10000);
  });

  it('resets backoff after cooldown expires via clearIfExpired', () => {
    const rl = new RateLimiter({ baseBackoffMs: 1000, maxBackoffMs: 60000 });
    const now = 1000000;

    // Escalate a few times
    rl.reportRateLimit(undefined, now);
    rl.reportRateLimit(undefined, now + 2000);

    // Let it expire and clear
    rl.clearIfExpired(now + 100000);

    // Should be back to base backoff
    rl.reportRateLimit(undefined, now + 100001);
    expect(rl.getCooldownUntil()).toBe(now + 100001 + 1000);
  });

  it('does not escalate when retry-after is provided', () => {
    const rl = new RateLimiter({ baseBackoffMs: 1000, maxBackoffMs: 60000 });
    const now = 1000000;

    // Report with explicit retry-after
    rl.reportRateLimit(30000, now);

    // Clear and report without retry-after — should use base, not escalated
    rl.clearIfExpired(now + 31000);
    rl.reportRateLimit(undefined, now + 31001);
    expect(rl.getCooldownUntil()).toBe(now + 31001 + 1000);
  });

  it('clearIfExpired returns false when no cooldown active', () => {
    const rl = new RateLimiter();
    expect(rl.clearIfExpired()).toBe(false);
  });

  it('clearIfExpired returns false when cooldown still active', () => {
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxBackoffMs: 60000 });
    const now = 1000000;
    rl.reportRateLimit(undefined, now);
    expect(rl.clearIfExpired(now + 1000)).toBe(false);
  });

  it('checkRateLimit auto-clears expired cooldowns', () => {
    const rl = new RateLimiter({ baseBackoffMs: 1000, maxBackoffMs: 60000 });
    const now = 1000000;
    rl.reportRateLimit(undefined, now);
    expect(rl.getConsecutiveCount()).toBe(1);

    // Check after expiry — should auto-clear
    const check = rl.checkRateLimit(now + 2000);
    expect(check.clear).toBe(true);
    expect(rl.getConsecutiveCount()).toBe(0);
  });
});
