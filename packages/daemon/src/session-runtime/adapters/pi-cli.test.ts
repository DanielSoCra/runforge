// src/session-runtime/adapters/pi-cli.test.ts
//
// FUNC-AC-RUNTIME-ADAPTERS v2 ACCEPTANCE GATE (IMMOVABLE).
//
// Pins the pi-cli process adapter (STACK v2): providerKind 'pi-cli', codex-cli
// shape (binary + flags + model from ProviderDefinition, exit status is the
// outcome authority, stdout wrapped into SessionResult), a continuation id for
// resume, estimate-and-mark cost, and a capability profile declaring
// nativeGuardHooks: false. No live pi process — spawn is mocked.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type {
  AgentDefinition,
  ProviderDefinition,
  SessionResult,
} from '../../types.js';
import type { Result } from '../../lib/result.js';
import { PiCliAdapter } from './pi-cli.js';
import { createProviderAdapter } from './index.js';

const agent: AgentDefinition = {
  name: 'worker',
  description: 'implements work',
  systemPrompt: '',
  allowedTools: ['Read', 'Edit'],
  modelOverride: 'pi-default',
  maxTurns: 4,
  timeoutMs: 30_000,
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

import { spawn as spawnMock } from 'child_process';
import {
  managedProcessCount,
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

describe('PiCliAdapter (#pi-cli v2)', () => {
  it('createProviderAdapter returns a PiCliAdapter for pi-cli providers', () => {
    expect(createProviderAdapter(piProvider)).toBeInstanceOf(PiCliAdapter);
  });

  it('builds args from provider flags + model, prompt last (codex-cli shape)', () => {
    const adapter = new PiCliAdapter();
    const args = adapter.buildArgs(agent, 'implement X', piProvider);
    expect(args).toEqual(['run', '--model', 'pi-coder', 'implement X']);
  });

  it('declares nativeGuardHooks: false in its capability profile', () => {
    const profile = new PiCliAdapter().capabilities();
    expect(profile.nativeGuardHooks).toBe(false);
  });
});

describe('PiCliAdapter.spawn() process wiring + outcome/cost legibility', () => {
  beforeEach(() => {
    __clearManagedProcessesForTests();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    __clearManagedProcessesForTests();
    vi.restoreAllMocks();
  });

  it('spawns the configured pi binary detached and registers/unregisters it', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new PiCliAdapter();
    const promise = adapter.spawn(agent, 'implement X', {
      cwd: '/tmp',
      provider: piProvider,
    });

    const call = vi.mocked(spawnMock).mock.calls[0];
    expect(call?.[0]).toBe('pi');
    const opts = call?.[2] as { detached?: boolean };
    expect(opts.detached).toBe(true);
    expect(managedProcessCount()).toBe(1);

    proc.stdout.emit('data', Buffer.from('implemented X'));
    proc.emit('close', 0);
    const result: Result<SessionResult> = await promise;

    expect(managedProcessCount()).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Exit status is the outcome authority (definite, not inferred from silence).
      expect(result.value.exitStatus).toBe('completed');
      // Cost is recorded; absent native cost → clearly-marked estimate, not zero.
      expect(result.value.costEstimated).toBe(true);
      expect(result.value.cost).toBeGreaterThan(0);
    }
  });

  it('a non-zero exit yields a definite failed outcome (never inferred from silence)', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new PiCliAdapter();
    const promise = adapter.spawn(agent, 'implement X', {
      cwd: '/tmp',
      provider: piProvider,
    });
    proc.stderr.emit('data', Buffer.from('pi crashed'));
    proc.emit('close', 1);
    const result: Result<SessionResult> = await promise;

    expect(result.ok).toBe(false);
  });
});
