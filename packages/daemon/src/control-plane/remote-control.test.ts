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
