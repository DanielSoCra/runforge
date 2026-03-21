import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// We test the manager's state machine without a real claude binary.
// Mock child_process.spawn to return controllable fake processes.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { RemoteControlManager } from './remote-control.js';

function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = Object.assign(new EventEmitter(), { pipe: vi.fn() });
  proc.kill = vi.fn();
  return proc;
}

describe('RemoteControlManager', () => {
  let manager: RemoteControlManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new RemoteControlManager();
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts in offline state', () => {
    const state = manager.getState();
    expect(state.remote_control_state).toBe('offline');
    expect(state.remote_control_url).toBeNull();
  });

  it('becomes active after URL parsed from stdout', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    manager.start();
    // claude remote-control prints the URL somewhere in its startup output
    proc.stdout.emit('data', Buffer.from('Remote control session: https://claude.ai/remote/abc123\n'));

    const state = manager.getState();
    expect(state.remote_control_state).toBe('active');
    expect(state.remote_control_url).toBe('https://claude.ai/remote/abc123');
  });

  it('becomes offline and schedules restart when process exits', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    manager.start();
    proc.stdout.emit('data', Buffer.from('Session URL: https://claude.ai/remote/abc123\n'));
    expect(manager.getState().remote_control_state).toBe('active');

    proc.emit('exit', 1);
    expect(manager.getState().remote_control_state).toBe('offline');
  });

  it('tracks offline state through each failure and reaches failed after 3 exits', async () => {
    let spawnCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      spawnCount++;
      const proc = makeFakeProcess();
      setTimeout(() => proc.emit('exit', 1), 0);
      return proc;
    });

    manager.start();
    expect(spawnCount).toBe(1);

    // Failure 1: exit fires → offline, backoff 5s (BACKOFF_MS[0])
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getState().remote_control_state).toBe('offline');

    // Backoff expires → spawn 2
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawnCount).toBe(2);

    // Failure 2: exit fires → offline, backoff 15s (BACKOFF_MS[1])
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getState().remote_control_state).toBe('offline');

    // Backoff expires → spawn 3
    await vi.advanceTimersByTimeAsync(15000);
    expect(spawnCount).toBe(3);

    // Failure 3: exit fires → failed (failureCount hits MAX_FAILURES)
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getState().remote_control_state).toBe('failed');
  });

  it('stop() then immediate start() is blocked while old process is still alive; old exit never causes restart', async () => {
    // Uses fake timers (set in beforeEach). We advance past all backoff delays
    // to prove no extra spawn is triggered by proc1's delayed exit event.
    //
    // The fix: stop() no longer nulls this.proc immediately. This means:
    //   1. A start() call while the old process is alive is correctly blocked
    //      by the this.proc guard (instead of seeing null and re-spawning).
    //   2. When the old process's exit event fires, this.stopped is still true
    //      (the second start() returned early, so it never reset stopped),
    //      so no spurious restart is scheduled.
    const proc1 = makeFakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(proc1);

    const mgr = new RemoteControlManager();
    mgr.start();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    // stop() sends SIGTERM but does NOT null this.proc (the fix).
    await mgr.stop();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    // start() while proc1 is still alive — should be blocked by the this.proc guard.
    mgr.start();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    // proc1's exit fires after start() was attempted.
    // With the old buggy code: stop() nulled this.proc, so start() spawned proc2,
    // and proc1's exit fired with this.stopped=false → spurious scheduleRestart.
    // With the fix: this.proc is still proc1 when start() is called, so start()
    // returns early; when proc1 exits, this.stopped is still true → no restart.
    proc1.emit('exit', 0);

    // Advance past all backoff delays — no restart should fire.
    await vi.advanceTimersByTimeAsync(60_000);

    // spawn was called exactly once — no spurious extra spawns.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(mgr.getState().remote_control_state).toBe('offline');
  });

  it('restart() resets failure count and spawns a fresh process', async () => {
    let spawnCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      spawnCount++;
      const proc = makeFakeProcess();
      // First process exits with failure to drive failureCount up.
      // Processes spawned after restart (spawnCount >= 3) also auto-exit so we
      // can drive the fresh failure cycle to completion.
      if (spawnCount === 1 || spawnCount >= 3) setTimeout(() => proc.emit('exit', 1), 0);
      return proc;
    });

    manager.start();
    // Drive one failure to increment failureCount
    await vi.advanceTimersByTimeAsync(1); // exit fires
    await vi.advanceTimersByTimeAsync(5000); // backoff expires, spawns proc 2
    expect(spawnCount).toBe(2);

    // restart() should stop proc2 and spawn proc3 with a clean failure count
    manager.restart();
    expect(spawnCount).toBe(3);
    expect(manager.getState().remote_control_state).toBe('offline');

    // After restart the failure counter is reset — proc3 can fail 3 times before reaching 'failed'
    // Drive 3 failures from the fresh start
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (i < 2) await vi.advanceTimersByTimeAsync([5000, 15000][i]!);
    }
    expect(manager.getState().remote_control_state).toBe('failed');
  });

  it('restart(): stale exit from old process does not null the new proc reference', async () => {
    let procs: ReturnType<typeof makeFakeProcess>[] = [];
    vi.mocked(spawn).mockImplementation(() => {
      const proc = makeFakeProcess();
      procs.push(proc);
      return proc;
    });

    manager.start();
    // proc[0] running — don't exit it yet

    manager.restart();
    // proc[1] is now running; proc[0] is still alive (hasn't exited)
    expect(procs).toHaveLength(2);

    // Now the old process (proc[0]) exits — should be ignored
    procs[0]!.emit('exit', 0);

    // proc[1] should still be tracked (not nulled), state should be offline (not failed)
    expect(manager.getState().remote_control_state).toBe('offline');
    // Verify proc[1] is still the active one by making it go active
    procs[1]!.stdout!.emit('data', Buffer.from('Session ready: https://session.example.com\n'));
    expect(manager.getState().remote_control_state).toBe('active');
    expect(manager.getState().remote_control_url).toBe('https://session.example.com');
  });

  it('regression #5: only one restart() method exists (no duplicate override)', () => {
    // Prior bug: two restart() methods were defined — an async version (properly
    // awaiting stop()) and a sync version. The sync version silently overrode
    // the async one at runtime. This test verifies the class has exactly one
    // restart method with the correct (sync) signature.
    const descriptor = Object.getOwnPropertyDescriptor(
      RemoteControlManager.prototype,
      'restart',
    );
    expect(descriptor).toBeDefined();
    expect(typeof descriptor!.value).toBe('function');
    // The working restart() is sync (returns void, not Promise<void>)
    vi.mocked(spawn).mockReturnValue(makeFakeProcess());
    const result = manager.restart();
    expect(result).toBeUndefined();
  });

  it('schedules immediate restart on clean active exit (code=0 after active)', async () => {
    let spawnCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      spawnCount++;
      return makeFakeProcess();
    });

    manager.start();
    expect(spawnCount).toBe(1);

    // Simulate process becoming active by emitting a URL
    const proc = vi.mocked(spawn).mock.results[0]!.value as ReturnType<typeof makeFakeProcess>;
    proc.stdout!.emit('data', Buffer.from('Session ready: https://session.example.com\n'));
    expect(manager.getState().remote_control_state).toBe('active');

    // Clean exit (code=0) from an active session
    proc.emit('exit', 0);

    // Should schedule restart with zero delay (BACKOFF_MS[-1] = undefined → 0ms)
    // and spawn again immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnCount).toBe(2);
    expect(manager.getState().remote_control_state).toBe('offline');
    // failureCount should NOT have been incremented (clean exit)
    // so it should NOT be in 'failed' state
    expect(manager.getState().remote_control_state).not.toBe('failed');
  });

  it('transitions to failed state when process emits error events', async () => {
    let spawnCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      spawnCount++;
      const proc = makeFakeProcess();
      setTimeout(() => proc.emit('error', new Error('spawn ENOENT')), 0);
      return proc;
    });

    manager.start();
    expect(spawnCount).toBe(1);

    // Error → offline, backoff 5s
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getState().remote_control_state).toBe('offline');

    await vi.advanceTimersByTimeAsync(5000);
    expect(spawnCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(spawnCount).toBe(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getState().remote_control_state).toBe('failed');
  });
});
