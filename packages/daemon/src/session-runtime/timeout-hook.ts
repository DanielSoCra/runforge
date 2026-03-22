// src/session-runtime/timeout-hook.ts
//
// Constants and helpers for the session timeout warning hook.
// Part of STACK-AC-HANDOFF-RUNTIME — warns operators when a session
// approaches its configured time limit.

/**
 * Warning message emitted by the timeout hook when a session nears expiry.
 * Displayed once per session via the PreToolUse hook mechanism.
 */
export const TIMEOUT_WARNING_MESSAGE =
  'Warning: Session approaching timeout. Consider saving progress and wrapping up.';
