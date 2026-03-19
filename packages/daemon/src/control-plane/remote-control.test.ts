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
  proc.stderr = new EventEmitter();
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

  it('transitions to failed after 3 consecutive restart failures', async () => {
    // The spec says "after three consecutive failed restart attempts" — failureCount reaches
    // MAX_FAILURES (3) on the third restart exit, triggering the failed state.
    vi.mocked(spawn).mockImplementation(() => {
      const proc = makeFakeProcess();
      // Immediately exit without emitting URL — simulates launch failure
      setTimeout(() => proc.emit('exit', 1), 0);
      return proc;
    });

    manager.start();

    // Each exit schedules a backoff timer. Advance through 3 exit cycles.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve(); // let setTimeout(exit) fire
      vi.runAllTimers();       // fire the backoff timer → triggers next spawn
      await Promise.resolve();
    }
    await Promise.resolve();

    expect(manager.getState().remote_control_state).toBe('failed');
  });
});
