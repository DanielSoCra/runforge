// src/session-runtime/adapters/contract-v2.test.ts
//
// FUNC-AC-RUNTIME-ADAPTERS v2 ACCEPTANCE GATE (IMMOVABLE).
//
// Pins the widened adapter contract (ARCH-AC-SESSION-PROVIDERS v2 / STACK v2):
//   ProviderAdapter gains resume(), abort(), capabilities();
//   SessionResult gains costEstimated; ContainmentCapabilityProfile is the
//   per-provider declaration the runtime composes safety from.
//
// These tests must FAIL until the v2 surface exists. Implementer (Kimi) makes
// them pass WITHOUT editing this file. No live model calls — spawn is mocked.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { AgentDefinition, ProviderDefinition } from '../../types.js';
import { CliAdapter, CodexCliAdapter } from './index.js';
import type {
  ProviderAdapter,
  ContainmentCapabilityProfile,
} from './types.js';

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

const codexProvider: ProviderDefinition = {
  name: 'codex-impl',
  adapterClass: 'process-based',
  providerKind: 'codex-cli',
  supportedModelTiers: ['higher-capability'],
  cliTool: 'codex',
  model: 'gpt-5.5',
  executionFlags: ['exec'],
};

describe('ProviderAdapter v2 contract — five operations', () => {
  it('CliAdapter implements spawn, resume, abort and capabilities', () => {
    const adapter: ProviderAdapter = new CliAdapter();
    expect(typeof adapter.spawn).toBe('function');
    expect(typeof adapter.resume).toBe('function');
    expect(typeof adapter.abort).toBe('function');
    expect(typeof adapter.capabilities).toBe('function');
  });

  it('CodexCliAdapter implements the full v2 contract', () => {
    const adapter: ProviderAdapter = new CodexCliAdapter();
    expect(typeof adapter.spawn).toBe('function');
    expect(typeof adapter.resume).toBe('function');
    expect(typeof adapter.abort).toBe('function');
    expect(typeof adapter.capabilities).toBe('function');
  });
});

describe('ContainmentCapabilityProfile declares native integrations', () => {
  it('Claude CLI declares native guard hooks present', () => {
    const profile: ContainmentCapabilityProfile = new CliAdapter().capabilities();
    expect(profile.nativeGuardHooks).toBe(true);
    // The four declared dimensions from ARCH-AC-SESSION-PROVIDERS v2.
    expect(typeof profile.structuredOutput).toBe('boolean');
    expect(typeof profile.exactCostReporting).toBe('boolean');
    expect(typeof profile.sessionContinuation).toBe('boolean');
  });

  it('Codex CLI (non-native-guard runtime) declares nativeGuardHooks: false', () => {
    const profile = new CodexCliAdapter().capabilities();
    expect(profile.nativeGuardHooks).toBe(false);
  });
});

// --- Cost legibility: every finished piece of work carries a recorded cost;
//     an estimate is clearly marked, never a silent zero. ---

vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

import { spawn as spawnMock } from 'child_process';
import { __clearManagedProcessesForTests } from '../managed-processes.js';

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

describe('Cost legibility — no silent zero cost', () => {
  beforeEach(() => {
    __clearManagedProcessesForTests();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    __clearManagedProcessesForTests();
    vi.restoreAllMocks();
  });

  it('codex adapter marks cost as estimated when the runtime reports none', async () => {
    const proc = mockProc();
    vi.mocked(spawnMock).mockReturnValue(proc as never);

    const adapter = new CodexCliAdapter();
    const promise = adapter.spawn(agent, 'do work', {
      cwd: '/tmp',
      provider: codexProvider,
    });
    proc.stdout.emit('data', Buffer.from('implemented the change'));
    proc.emit('close', 0);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      // A provider that cannot report exact cost must mark the estimate, not
      // silently record zero (STACK gotcha: costEstimated: true).
      expect(result.value.costEstimated).toBe(true);
      expect(result.value.cost).toBeGreaterThan(0);
    }
  });

  it('parseOutput surfaces costEstimated rather than a bare zero', () => {
    const adapter = new CodexCliAdapter();
    const parsed = adapter.parseOutput('done\n');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.costEstimated).toBe(true);
    }
  });
});
