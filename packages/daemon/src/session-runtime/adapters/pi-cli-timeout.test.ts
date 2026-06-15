// src/session-runtime/adapters/pi-cli-timeout.test.ts
//
// Non-gate unit test for pi-cli timeout escalation: SIGTERM first, then SIGKILL
// after a grace period if the child ignores SIGTERM.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { AgentDefinition, ProviderDefinition } from '../../types.js';
import { PiCliAdapter } from './pi-cli.js';

const agent: AgentDefinition = {
  name: 'worker',
  description: 'implements work',
  systemPrompt: '',
  allowedTools: ['Read', 'Edit'],
  modelOverride: 'pi-default',
  maxTurns: 4,
  timeoutMs: 1_000,
  budgetCap: 1,
};

const piProvider: ProviderDefinition = {
  name: 'pi-impl',
  adapterClass: 'process-based',
  providerKind: 'pi-cli',
  supportedModelTiers: ['standard-capability'],
  cliTool: 'pi',
  model: 'pi-coder',
  executionFlags: ['run'],
};

vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../managed-processes.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    killProcessGroup: vi.fn(),
  };
});

import { spawn as spawnMock } from 'child_process';
import { killProcessGroup } from '../managed-processes.js';
import {
  __clearManagedProcessesForTests,
} from '../managed-processes.js';

function mockProc(pid = 7777) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = pid;
  return proc;
}

describe('PiCliAdapter timeout escalation', () => {
  beforeEach(() => {
    __clearManagedProcessesForTests();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    __clearManagedProcessesForTests();
    vi.restoreAllMocks();
  });

  it('sends SIGTERM on timeout, then SIGKILL after the grace period', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new PiCliAdapter();
    const promise = adapter.spawn(agent, 'implement X', {
      cwd: '/tmp',
      provider: piProvider,
    });

    // Advance past the session timeout to trigger SIGTERM.
    await vi.advanceTimersByTimeAsync(agent.timeoutMs);
    expect(killProcessGroup).toHaveBeenCalledWith(proc, 'SIGTERM');
    expect(killProcessGroup).not.toHaveBeenCalledWith(proc, 'SIGKILL');

    // Advance past the SIGTERM grace period to force SIGKILL.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killProcessGroup).toHaveBeenCalledWith(proc, 'SIGKILL');

    // Let the process finally close so the promise resolves.
    proc.emit('close', 0);
    await promise;
  });

  it('clears the SIGKILL timer when the process exits during the grace period', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new PiCliAdapter();
    const promise = adapter.spawn(agent, 'implement X', {
      cwd: '/tmp',
      provider: piProvider,
    });

    await vi.advanceTimersByTimeAsync(agent.timeoutMs);
    expect(killProcessGroup).toHaveBeenCalledTimes(1);
    expect(killProcessGroup).toHaveBeenLastCalledWith(proc, 'SIGTERM');

    // Process exits during grace period — SIGKILL should not fire.
    proc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killProcessGroup).toHaveBeenCalledTimes(1);

    await promise;
  });
});
