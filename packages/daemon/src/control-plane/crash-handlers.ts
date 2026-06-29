// Top-level crash handlers (B5 / T2.7, first-use safety net). An
// uncaughtException or unhandledRejection that escapes the daemon's normal
// control flow would otherwise either silently keep a half-dead process alive or
// hard-exit with no operator signal. These handlers notify the Operator (when a
// channel is configured) and exit with a NON-ZERO code — but with a BOUNDED
// fatal-drain: a graceful drain is attempted, yet a force-exit timer guarantees
// the process exits even if the drain never resolves (e.g. the fatal fault is
// itself a wedged run whose slot never releases, so drain would wait forever).
//
// Built as a pure factory so the behavior is unit-testable without registering
// real process listeners or actually exiting. The daemon wires the returned
// handlers via `process.on(...)` INSIDE startDaemon (after config load), where
// the alert channel and the private drain are in scope — main.ts has neither.
import type { NotificationPayload } from './notify.js';

/** Default upper bound on the fatal graceful-drain before a forced exit. */
export const DEFAULT_FATAL_DRAIN_TIMEOUT_MS = 5000;

interface TimerLike {
  unref?: () => void;
}

export interface CrashHandlerDeps {
  /** Fire-and-forget operator alert (no-op + warn when no channel — see daemon). */
  notifyOperator: (payload: NotificationPayload) => void;
  /** Graceful drain/shutdown. May resolve, reject, or NEVER resolve. */
  shutdown: () => Promise<void> | void;
  /** Set the process exit code (so the supervisor sees a failure). */
  setExitCode: (code: number) => void;
  /** Hard-exit the process. Defaults to `process.exit`. Injectable for tests. */
  forceExit?: (code: number) => void;
  /** Upper bound on the graceful drain before forceExit. */
  drainTimeoutMs?: number;
  /** Schedules the bounded force-exit. Defaults to setTimeout. Injectable. */
  scheduleTimeout?: (fn: () => void, ms: number) => TimerLike;
  /** Structured logger; defaults to console.error. */
  log?: (message: string, error: unknown) => void;
}

export interface CrashHandlers {
  onUncaughtException: (error: Error) => void;
  onUnhandledRejection: (reason: unknown) => void;
}

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export function createCrashHandlers(deps: CrashHandlerDeps): CrashHandlers {
  const log =
    deps.log ??
    ((message: string, error: unknown) => console.error(message, error));
  const forceExit = deps.forceExit ?? ((code: number) => process.exit(code));
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_FATAL_DRAIN_TIMEOUT_MS;
  const scheduleTimeout =
    deps.scheduleTimeout ??
    ((fn: () => void, ms: number): TimerLike => setTimeout(fn, ms));
  // Re-entrancy latch: the first fatal event owns the graceful exit; a second
  // crash mid-drain must not re-notify or re-trigger shutdown (restart storm).
  let handling = false;
  // Exit-once latch: whether the bounded drain completed first or the timeout
  // fired first, the process exits exactly once.
  let exited = false;

  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    forceExit(1);
  };

  const handle = (
    label: 'uncaughtException' | 'unhandledRejection',
    reason: unknown,
  ): void => {
    if (handling) return;
    handling = true;
    log(`[daemon] FATAL ${label} — notifying operator and draining`, reason);
    deps.notifyOperator({
      event: 'daemon-crash',
      issueNumber: 0,
      phase: label,
      message: `Daemon ${label}: ${reasonMessage(reason)}`,
    });
    deps.setExitCode(1);

    // Bounded fatal-drain: schedule a force-exit so a never-resolving drain (the
    // fatal fault is itself a wedged run) cannot leave the process draining
    // forever. The timer is unref'd so a CLEAN drain that empties the event loop
    // exits naturally first, without the timer holding the loop open.
    const timer = scheduleTimeout(exitOnce, drainTimeoutMs);
    timer.unref?.();

    // Attempt the graceful drain; on settle (resolve OR reject) exit promptly,
    // never re-throwing out of the process handler.
    void Promise.resolve()
      .then(() => deps.shutdown())
      .then(exitOnce, exitOnce);
  };

  return {
    onUncaughtException: (error) => handle('uncaughtException', error),
    onUnhandledRejection: (reason) => handle('unhandledRejection', reason),
  };
}
