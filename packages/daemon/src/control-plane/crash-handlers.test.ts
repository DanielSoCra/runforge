import { describe, it, expect, vi } from 'vitest';
import { createCrashHandlers } from './crash-handlers.js';
import type { NotificationPayload } from './notify.js';

// Flush enough microtasks for the `Promise.resolve().then(shutdown).then(exit)`
// chain (incl. thenable adoption) to settle. No real timers involved.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deps(over: Partial<Parameters<typeof createCrashHandlers>[0]> = {}) {
  const notifyOperator = vi.fn<(p: NotificationPayload) => void>();
  const shutdown = vi.fn(async () => {});
  const setExitCode = vi.fn<(c: number) => void>();
  const forceExit = vi.fn<(c: number) => void>();
  const log = vi.fn();
  // Capture the scheduled bounded-exit timer so tests can drive it manually
  // instead of waiting on a real timer (no real timers).
  const scheduled: Array<{ fn: () => void; ms: number; unref: () => void }> = [];
  const scheduleTimeout = vi.fn((fn: () => void, ms: number) => {
    const entry = { fn, ms, unref: vi.fn() };
    scheduled.push(entry);
    return entry;
  });
  const handlers = createCrashHandlers({
    notifyOperator,
    shutdown,
    setExitCode,
    forceExit,
    scheduleTimeout,
    log,
    ...over,
  });
  return {
    handlers,
    notifyOperator,
    shutdown,
    setExitCode,
    forceExit,
    scheduleTimeout,
    scheduled,
    log,
  };
}

describe('createCrashHandlers', () => {
  it('on unhandledRejection: notifies the operator, sets exit code 1, drains, and exits', async () => {
    const { handlers, notifyOperator, shutdown, setExitCode, forceExit } = deps();

    handlers.onUnhandledRejection(new Error('boom'));
    await flushMicrotasks();

    expect(notifyOperator).toHaveBeenCalledTimes(1);
    expect(notifyOperator.mock.calls[0]![0]).toMatchObject({
      event: 'daemon-crash',
      phase: 'unhandledRejection',
    });
    expect(notifyOperator.mock.calls[0]![0].message).toContain('boom');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    // Clean drain resolved → exit immediately with code 1.
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('on uncaughtException: same graceful path', async () => {
    const { handlers, notifyOperator, shutdown, setExitCode, forceExit } = deps();

    handlers.onUncaughtException(new Error('kapow'));
    await flushMicrotasks();

    expect(notifyOperator).toHaveBeenCalledTimes(1);
    expect(notifyOperator.mock.calls[0]![0].phase).toBe('uncaughtException');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('WAITS for shutdown to ACTUALLY complete before exiting (does not exit immediately on an active run)', async () => {
    // The daemon wires `shutdown` to a promise that resolves only when the real
    // graceful shutdown finishes (active runs drained + cleanup). Simulate a
    // still-running run: the shutdown promise stays pending, so no exit yet.
    let resolveShutdown!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const { handlers, forceExit, setExitCode } = deps({ shutdown });

    handlers.onUncaughtException(new Error('crash during active run'));
    await flushMicrotasks();

    // Drain in progress (run not finished) → exit code set, but NOT exited yet.
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(forceExit).not.toHaveBeenCalled();

    // The active run completes → graceful shutdown resolves → THEN exit.
    resolveShutdown();
    await flushMicrotasks();
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('BOUNDED fatal-drain: a drain that NEVER resolves still forces an exit via the timer', async () => {
    // The fatal fault is itself a wedged run: drain never settles.
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const { handlers, forceExit, scheduled, scheduleTimeout } = deps({
      shutdown,
      drainTimeoutMs: 5000,
    });

    handlers.onUncaughtException(new Error('wedged'));
    await Promise.resolve();

    // The drain has not resolved → no exit yet from the drain path.
    expect(forceExit).not.toHaveBeenCalled();
    // A bounded force-exit timer was scheduled (and unref'd so it never holds the
    // loop open on a clean exit).
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.unref).toHaveBeenCalledTimes(1);

    // Fire the bounded timer → the process is force-exited regardless of the hung drain.
    scheduled[0]!.fn();
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('exits exactly once even if both the drain settles AND the timer fires', async () => {
    const { handlers, forceExit, scheduled } = deps();

    handlers.onUncaughtException(new Error('x'));
    await flushMicrotasks();
    // Drain already exited once.
    expect(forceExit).toHaveBeenCalledTimes(1);
    // The (now redundant) timer firing must NOT double-exit.
    scheduled[0]!.fn();
    expect(forceExit).toHaveBeenCalledTimes(1);
  });

  it('is re-entrancy-safe: a second crash while handling does not re-drain or re-notify', async () => {
    const { handlers, notifyOperator, shutdown } = deps();

    handlers.onUncaughtException(new Error('first'));
    handlers.onUnhandledRejection(new Error('second'));
    await Promise.resolve();

    expect(notifyOperator).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('a shutdown that rejects still exits (does not throw out of the handler)', async () => {
    const shutdown = vi.fn(async () => {
      throw new Error('drain failed');
    });
    const { handlers, setExitCode, forceExit } = deps({ shutdown });

    expect(() => handlers.onUncaughtException(new Error('x'))).not.toThrow();
    await flushMicrotasks();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('tolerates a non-Error rejection reason', async () => {
    const { handlers, notifyOperator } = deps();
    handlers.onUnhandledRejection('string reason');
    await flushMicrotasks();
    expect(notifyOperator.mock.calls[0]![0].message).toContain('string reason');
  });
});
