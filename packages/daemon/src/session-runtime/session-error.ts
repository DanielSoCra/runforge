// src/session-runtime/session-error.ts

/**
 * Error class for session failures that may have consumed tokens.
 * Carries an optional `cost` field so the runtime can track spending
 * even when a session fails (ARCH-AC-SESSION-RUNTIME step 10).
 */
export class SessionError extends Error {
  readonly cost: number;
  readonly rateLimited: boolean;
  readonly containmentBreach: boolean;
  readonly scopeViolation: boolean;

  constructor(message: string, cost = 0, rateLimited = false, containmentBreach = false, scopeViolation = false) {
    super(message);
    this.name = 'SessionError';
    this.cost = cost;
    this.rateLimited = rateLimited;
    this.containmentBreach = containmentBreach;
    this.scopeViolation = scopeViolation;
  }

  static budgetExceeded(reason: string): SessionError {
    return new SessionError(`Budget exceeded: ${reason}`, 0);
  }

  static rateLimited(cost: number, remainingMs?: number): SessionError {
    const msg = remainingMs !== undefined
      ? `Rate limited: cooling down for ${Math.ceil(remainingMs / 1000)}s`
      : 'Rate limited';
    return new SessionError(msg, cost, true);
  }

  static containmentBreached(details: string, cost: number): SessionError {
    return new SessionError(`Containment breach detected: ${details}`, cost, false, true);
  }

  static scopeViolated(details: string, cost: number): SessionError {
    return new SessionError(`Scope violation detected: ${details}`, cost, false, true, true);
  }
}
