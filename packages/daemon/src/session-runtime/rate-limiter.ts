// src/session-runtime/rate-limiter.ts

export type RateLimitCheck =
  | { clear: true }
  | { clear: false; remainingMs: number };

export interface RateLimiterConfig {
  baseBackoffMs: number;
  maxBackoffMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
};

/**
 * Tracks rate limit state for the WorkerPool.
 *
 * Per ARCH-AC-SESSION-RUNTIME: maintains cooldown-until timestamp,
 * consecutive rate limit count, and current backoff duration.
 * Escalating backoff doubles on each consecutive signal, capped at maxBackoffMs.
 */
export class RateLimiter {
  private cooldownUntil = 0;
  private consecutiveCount = 0;
  private currentBackoffMs: number;
  private readonly config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentBackoffMs = this.config.baseBackoffMs;
  }

  /**
   * Check if a cooldown is active.
   * Auto-clears expired cooldowns before returning.
   */
  checkRateLimit(now = Date.now()): RateLimitCheck {
    if (this.cooldownUntil <= now) {
      this.clearIfExpired(now);
      return { clear: true };
    }
    return { clear: false, remainingMs: this.cooldownUntil - now };
  }

  /**
   * Report a rate limit signal from a session.
   * Sets cooldown using the provided retry-after duration or escalating backoff.
   */
  reportRateLimit(retryAfterMs?: number, now = Date.now()): void {
    this.consecutiveCount++;
    const backoff = retryAfterMs ?? this.currentBackoffMs;
    this.cooldownUntil = now + backoff;

    // Escalate backoff for next time (only when using internal backoff)
    if (retryAfterMs === undefined) {
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * 2,
        this.config.maxBackoffMs,
      );
    }
  }

  /**
   * Clear rate limit state if the cooldown has expired.
   */
  clearIfExpired(now = Date.now()): boolean {
    if (this.cooldownUntil > 0 && this.cooldownUntil <= now) {
      this.cooldownUntil = 0;
      this.consecutiveCount = 0;
      this.currentBackoffMs = this.config.baseBackoffMs;
      return true;
    }
    return false;
  }

  getConsecutiveCount(): number {
    return this.consecutiveCount;
  }

  getCooldownUntil(): number {
    return this.cooldownUntil;
  }
}
