import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { CodexCliAdapter } from './codex-cli.js';
import type { AgentDefinition, ProviderDefinition } from '../../types.js';

const agent: AgentDefinition = {
  name: 'classifier',
  description: 'classifies work',
  systemPrompt: '',
  allowedTools: ['Read', 'Grep'],
  modelOverride: 'claude-haiku-4-5-20251001',
  maxTurns: 1,
  timeoutMs: 30_000,
  budgetCap: 0.5,
};

const provider: ProviderDefinition = {
  name: 'codex-planner',
  adapterClass: 'process-based',
  providerKind: 'codex-cli',
  supportedModelTiers: ['higher-capability'],
  cliTool: 'codex',
  model: 'gpt-5.5',
  executionFlags: ['exec', '--full-auto'],
};

describe('CodexCliAdapter (#480)', () => {
  it('builds args from provider flags and provider model', () => {
    const adapter = new CodexCliAdapter();
    const args = adapter.buildArgs(agent, 'plan this', provider);

    expect(args).toEqual([
      'exec',
      '--full-auto',
      '--model',
      'gpt-5.5',
      'plan this',
    ]);
  });

  it('wraps plain stdout into a SessionResult payload', () => {
    const adapter = new CodexCliAdapter();
    const parsed = adapter.parseOutput('implemented the plan\n');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.output).toBe('implemented the plan');
      expect(parsed.value.cost).toBe(0);
      expect(parsed.value.structuredData).toEqual({
        provider: 'codex-cli',
        raw: 'implemented the plan\n',
      });
    }
  });
});

vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

import { spawn as spawnMock } from 'child_process';
import {
  managedProcessCount,
  __clearManagedProcessesForTests,
} from '../managed-processes.js';

function createMockProcess(pid = 54321) {
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

describe('CodexCliAdapter.spawn() force-kill wiring (runaway envelope)', () => {
  beforeEach(() => {
    __clearManagedProcessesForTests();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    __clearManagedProcessesForTests();
    vi.restoreAllMocks();
  });

  it('spawns the codex child detached and registers/unregisters it', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CodexCliAdapter();
    const promise = adapter.spawn(agent, 'plan this', {
      cwd: '/tmp',
      provider,
    });

    const opts = vi.mocked(spawnMock).mock.calls[0]?.[2] as {
      detached?: boolean;
    };
    expect(opts.detached).toBe(true);
    expect(managedProcessCount()).toBe(1);

    mockProc.stdout.emit('data', Buffer.from('done'));
    mockProc.emit('close', 0);
    await promise;

    expect(managedProcessCount()).toBe(0);
  });
});
