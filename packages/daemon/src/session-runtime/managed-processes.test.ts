// src/session-runtime/managed-processes.test.ts
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  registerManagedProcess,
  unregisterManagedProcess,
  killAllManagedProcessGroups,
  killProcessGroup,
  managedProcessCount,
  __clearManagedProcessesForTests,
} from './managed-processes.js';

// A fake ChildProcess: an EventEmitter with a pid. We assert on the kill
// SIGNAL delivery via a spy on process.kill, since the real force path sends to
// the process GROUP (negative pid), not via proc.kill(). Only `pid` is read by
// the registry, so the cast is sound for these tests.
function fakeChild(pid: number): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & { pid: number };
  proc.pid = pid;
  return proc as unknown as ChildProcess;
}

describe('managed-processes (force-kill registry)', () => {
  let killSpy: MockInstance<typeof process.kill>;

  beforeEach(() => {
    __clearManagedProcessesForTests();
    // Stub process.kill so the test does not actually signal anything real.
    killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true) as MockInstance<typeof process.kill>;
  });

  afterEach(() => {
    __clearManagedProcessesForTests();
    killSpy.mockRestore();
  });

  it('starts empty', () => {
    expect(managedProcessCount()).toBe(0);
  });

  it('registers and unregisters a child', () => {
    const child = fakeChild(111);
    registerManagedProcess(child);
    expect(managedProcessCount()).toBe(1);
    unregisterManagedProcess(child);
    expect(managedProcessCount()).toBe(0);
  });

  it('SIGKILLs the process GROUP (negative pid) of every registered child', () => {
    registerManagedProcess(fakeChild(222));
    registerManagedProcess(fakeChild(333));

    const killed = killAllManagedProcessGroups('SIGKILL');

    expect(killed).toBe(2);
    expect(killSpy).toHaveBeenCalledWith(-222, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-333, 'SIGKILL');
  });

  it('does not throw when a child has already exited (ESRCH swallowed)', () => {
    registerManagedProcess(fakeChild(444));
    killSpy.mockImplementation(() => {
      const e = new Error('no such process') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    });
    // Must be a clean count, never a throw — operator kill must be reliable.
    expect(() => killAllManagedProcessGroups('SIGKILL')).not.toThrow();
  });

  it('clears the registry after a kill sweep (idempotent re-kill is a no-op)', () => {
    registerManagedProcess(fakeChild(555));
    killAllManagedProcessGroups('SIGKILL');
    expect(managedProcessCount()).toBe(0);
    // Second sweep finds nothing.
    expect(killAllManagedProcessGroups('SIGKILL')).toBe(0);
  });

  it('skips children without a pid (never spawned / already reaped)', () => {
    const child = fakeChild(undefined as unknown as number);
    registerManagedProcess(child);
    const killed = killAllManagedProcessGroups('SIGKILL');
    expect(killed).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  describe('killProcessGroup (single child, timeout path)', () => {
    it('signals the process group (negative pid)', () => {
      const ok = killProcessGroup(fakeChild(777), 'SIGTERM');
      expect(ok).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-777, 'SIGTERM');
    });

    it('returns false (no throw) when the child already exited', () => {
      killSpy.mockImplementation(() => {
        const e = new Error('no such process') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      });
      expect(killProcessGroup(fakeChild(888), 'SIGKILL')).toBe(false);
    });

    it('no-ops on a child without a pid', () => {
      expect(
        killProcessGroup(fakeChild(undefined as unknown as number)),
      ).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
    });
  });
});
