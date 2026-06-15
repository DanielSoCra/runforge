// src/session-runtime/adapters/continuation-id.test.ts
//
// Non-gate unit test for the continuation id flow:
//   - continuation-capable adapters surface the provider-native/resumed id in
//     the returned SessionResult;
//   - SessionRuntime.toResumeState persists that id as a SessionResumeState.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { AgentDefinition, ProviderDefinition } from '../../types.js';
import { CliAdapter, CodexCliAdapter, PiCliAdapter } from './index.js';
import { SessionRuntime } from '../runtime.js';
import { CostTracker } from '../cost.js';
import { ConfigSchema } from '../../config.js';

const agent: AgentDefinition = {
  name: 'worker',
  description: 'implements work',
  systemPrompt: '',
  allowedTools: ['Read', 'Edit'],
  modelOverride: 'claude-sonnet-4-5',
  maxTurns: 4,
  timeoutMs: 30_000,
  budgetCap: 1,
};

const claudeProvider: ProviderDefinition = {
  name: 'claude-default',
  adapterClass: 'process-based',
  providerKind: 'claude-cli',
  supportedModelTiers: ['standard-capability', 'higher-capability'],
  cliTool: 'claude',
};

const baseConfig = {
  repo: { owner: 'test-owner', name: 'test-repo' },
  controlPort: 3847,
  pollIntervalMs: 30000,
  maxConcurrentRuns: 1,
  dailyBudget: 50,
  perRunBudget: 10,
  adapter: 'cli' as const,
  branches: { staging: 'staging', production: 'main' },
  webhooks: [],
  validation: {
    gate1Commands: ['vitest run', 'tsc --noEmit'],
    maxFixCycles: 3,
  },
};

vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

import { spawn as spawnMock } from 'child_process';
import {
  __clearManagedProcessesForTests,
} from '../managed-processes.js';

function mockProc(pid = 4242) {
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

function makeRuntime(): SessionRuntime {
  const parsed = ConfigSchema.safeParse({
    ...baseConfig,
    providers: {
      defaultProvider: 'claude-default',
      fallbackChain: [],
      definitions: {
        'claude-default': claudeProvider,
      },
    },
  });
  if (!parsed.success) throw new Error('Invalid config');
  return new SessionRuntime(parsed.data, new CostTracker(parsed.data));
}

describe('Adapter resume surfaces continuationId', () => {
  beforeEach(() => {
    __clearManagedProcessesForTests();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    __clearManagedProcessesForTests();
    vi.restoreAllMocks();
  });

  it('CliAdapter.resume echoes the continuation id on success', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new CliAdapter();
    const promise = adapter.resume(agent, 'continue', 'cont-123', {
      cwd: '/tmp',
      provider: claudeProvider,
    });
    proc.stdout.emit(
      'data',
      Buffer.from('{"result":"done","cost_usd":0.01}'),
    );
    proc.emit('close', 0);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.continuationId).toBe('cont-123');
    }
  });

  it('CodexCliAdapter.resume surfaces the continuation id on success', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new CodexCliAdapter();
    const promise = adapter.resume(agent, 'continue', 'cont-456', {
      cwd: '/tmp',
      provider: {
        ...claudeProvider,
        providerKind: 'codex-cli',
        cliTool: 'codex',
      },
    });
    proc.stdout.emit('data', Buffer.from('implemented the change'));
    proc.emit('close', 0);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.continuationId).toBe('cont-456');
    }
  });

  it('PiCliAdapter.resume surfaces the continuation id on success', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new PiCliAdapter();
    const promise = adapter.resume(agent, 'continue', 'cont-789', {
      cwd: '/tmp',
      provider: {
        ...claudeProvider,
        providerKind: 'pi-cli',
        cliTool: 'pi',
      },
    });
    proc.stdout.emit('data', Buffer.from('implemented the change'));
    proc.emit('close', 0);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.continuationId).toBe('cont-789');
    }
  });
});

describe('SessionRuntime.toResumeState', () => {
  it('persists a SessionResumeState from a result that carries a continuationId', () => {
    const runtime = makeRuntime();
    const state = runtime.toResumeState(
      'run-1',
      'worker',
      'claude-default',
      'claude-sonnet-4-5',
      '/work/run-1',
      'base-sha-aaa',
      {
        output: 'done',
        structuredData: null,
        cost: 0.01,
        pitfallMarkers: [],
        exitStatus: 'completed',
        continuationId: 'cont-xyz',
      },
    );

    expect(state).not.toBeUndefined();
    expect(state?.continuationId).toBe('cont-xyz');
    expect(state?.providerName).toBe('claude-default');
    expect(state?.modelBinding).toBe('claude-sonnet-4-5');
    expect(state?.validity).toBe('valid');
  });

  it('returns undefined when the result has no continuationId', () => {
    const runtime = makeRuntime();
    const state = runtime.toResumeState(
      'run-1',
      'worker',
      'claude-default',
      'claude-sonnet-4-5',
      '/work/run-1',
      'base-sha-aaa',
      {
        output: 'done',
        structuredData: null,
        cost: 0.01,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    );

    expect(state).toBeUndefined();
  });
});
