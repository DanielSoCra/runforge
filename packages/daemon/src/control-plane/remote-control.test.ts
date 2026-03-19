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
    vi.mocked(spawn).mockImplementation(() => {
      const proc = makeFakeProcess();
      setTimeout(() => proc.emit('exit', 1), 0);
      return proc;
    });

    manager.start();
    await vi.runAllTimersAsync();

    expect(manager.getState().remote_control_state).toBe('failed');
  });
});
