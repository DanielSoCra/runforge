// src/session-runtime/session-error.ts

/**
 * Error class for session failures that may have consumed tokens.
 * Carries an optional `cost` field so the runtime can track spending
 * even when a session fails (ARCH-AC-SESSION-RUNTIME step 10).
 */
export class SessionError extends Error {
  readonly cost: number;
  readonly rateLimited: boolean;

  constructor(message: string, cost = 0, rateLimited = false) {
    super(message);
    this.name = 'SessionError';
    this.cost = cost;
    this.rateLimited = rateLimited;
  }
}
