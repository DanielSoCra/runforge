// src/session-runtime/timeout-hook.ts
//
// Constants and helpers for the session timeout warning hook.
// Part of STACK-AC-HANDOFF-RUNTIME — warns operators when a session
// approaches its configured time limit.

/**
 * Warning message emitted by the timeout hook when a session nears expiry.
 * Displayed once per session via the PreToolUse hook mechanism.
 *
 * KEEP IN SYNC with .claude/hooks/timeout-warning.sh (hardcoded copy for CLI adapter).
 */
export const TIMEOUT_WARNING_MESSAGE =
  'Warning: Session approaching timeout. ' +
  'Save your progress by writing a handoff note between [HANDOFF] and [/HANDOFF] delimiters. ' +
  'Include: what you completed, what failed, and what to try next. Example:\n' +
  '[HANDOFF]\n' +
  'Completed: implemented X in file Y\n' +
  'Failed: approach Z due to constraint W\n' +
  'Next: try alternative approach A\n' +
  '[/HANDOFF]';
