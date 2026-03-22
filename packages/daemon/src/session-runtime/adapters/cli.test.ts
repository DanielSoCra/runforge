// src/session-runtime/adapters/cli.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import { CliAdapter } from './cli.js';
import { DEFAULT_POLICY } from '../containment-hooks.js';
import { SessionError } from '../session-error.js';
import type { AgentDefinition, SessionContext } from '../../types.js';

// We can't easily spawn a real `claude` process in tests.
// Instead, test the arg construction and env isolation logic.

const mockDef: AgentDefinition = {
  name: 'test-worker',
  description: 'Test agent',
  systemPrompt: 'You are a test agent.',
  allowedTools: ['Read', 'Write', 'Bash'],
  maxTurns: 5,
  timeoutMs: 30000,
  budgetCap: 1,
};

const mockCtx: SessionContext = {
  variables: { task: 'implement foo' },
  workspacePath: '/tmp/workspace',
};

describe('CliAdapter', () => {
  it('builds correct CLI args', () => {
    const adapter = new CliAdapter();
    const args = adapter.buildArgs(mockDef, 'assembled prompt');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--max-turns');
    expect(args).toContain('5');
  });

  it('includes --allowedTools as comma-separated list', () => {
    const adapter = new CliAdapter();
    const args = adapter.buildArgs(mockDef, 'prompt');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read,Write,Bash');
  });

  it('includes --json-schema when schema is provided', () => {
    const adapter = new CliAdapter();
    const schema = JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } });
    const args = adapter.buildArgs(mockDef, 'prompt', schema);
    expect(args).toContain('--json-schema');
    expect(args).toContain(schema);
  });

  it('builds safe environment without secrets', () => {
    process.env['API_SECRET'] = 'should-not-leak';
    const adapter = new CliAdapter();
    const env = adapter.buildEnv();
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.TERM).toBe('dumb');
    expect(env.API_SECRET).toBeUndefined();
    delete process.env['API_SECRET'];
  });

  it('parses valid JSON session output', () => {
    const adapter = new CliAdapter();
    const stdout = JSON.stringify({
      result: 'some output',
      cost_usd: 0.05,
      session_id: 'sess-123',
    });
    const parsed = adapter.parseOutput(stdout);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.output).toBe('some output');
      expect(parsed.value.cost).toBe(0.05);
    }
  });

  it('handles non-JSON stdout gracefully', () => {
    const adapter = new CliAdapter();
    const parsed = adapter.parseOutput('not json at all');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.output).toBe('not json at all');
      expect(parsed.value.cost).toBe(0);
    }
  });
});

describe('CliAdapter.extractHandoff (#11)', () => {
  it('extracts handoff note from session output', () => {
    const adapter = new CliAdapter();
    const output = 'some work done\n[HANDOFF]Stopped at step 3\nNext: continue[/HANDOFF]\nmore text';
    expect(adapter.extractHandoff(output)).toBe('Stopped at step 3\nNext: continue');
  });

  it('returns undefined when no handoff block present', () => {
    const adapter = new CliAdapter();
    expect(adapter.extractHandoff('just normal output')).toBeUndefined();
  });

  it('returns undefined for empty handoff block (spec: treat as absent)', () => {
    const adapter = new CliAdapter();
    expect(adapter.extractHandoff('[HANDOFF]   [/HANDOFF]')).toBeUndefined();
  });

  it('returns undefined for empty string handoff', () => {
    const adapter = new CliAdapter();
    expect(adapter.extractHandoff('[HANDOFF][/HANDOFF]')).toBeUndefined();
  });
});

describe('CliAdapter.isRateLimitError (#91)', () => {
  it('detects "rate limit" in text', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('Error: rate limit exceeded')).toBe(true);
  });

  it('detects "rate_limit" in text', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('error_type: rate_limit_error')).toBe(true);
  });

  it('detects "overloaded_error" in text', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('error_type: overloaded_error')).toBe(true);
  });

  it('detects "api is overloaded" in text', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('API is overloaded')).toBe(true);
  });

  it('does not false-positive on "overloaded method"', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('overloaded method signature')).toBe(false);
  });

  it('does not false-positive on 429 in a file path', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('/data/item429/output.json')).toBe(false);
  });

  it('matches word-boundary 429 in error messages', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('HTTP 429 Too Many Requests')).toBe(true);
    expect(adapter.isRateLimitError('status: 429')).toBe(true);
  });

  it('returns false for empty string', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('')).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    const adapter = new CliAdapter();
    expect(adapter.isRateLimitError('TypeError: cannot read property')).toBe(false);
  });
});

describe('CliAdapter containment hook setup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-adapter-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .claude/settings.local.json with PreToolUse hooks', () => {
    const adapter = new CliAdapter();
    const paths = adapter.setupHooks(tempDir, DEFAULT_POLICY, 30000);

    // Hook scripts should exist (containment + timeout)
    for (const p of paths.scriptPaths) {
      expect(existsSync(p)).toBe(true);
    }
    expect(paths.scriptPaths.length).toBe(2);

    // Settings file should exist with hook config
    const settingsPath = join(tempDir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse.length).toBe(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('node "');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(paths.scriptPaths[0]);

    adapter.cleanupHooks(paths);
  });

  it('cleans up hook scripts and settings after cleanup', () => {
    const adapter = new CliAdapter();
    const paths = adapter.setupHooks(tempDir, DEFAULT_POLICY, 30000);

    adapter.cleanupHooks(paths);

    // Hook scripts should be deleted
    for (const p of paths.scriptPaths) {
      expect(existsSync(p)).toBe(false);
    }

    // Empty settings file should be deleted
    expect(existsSync(paths.settingsPath)).toBe(false);
  });

  it('preserves existing settings when cleaning up', () => {
    const adapter = new CliAdapter();

    // Pre-existing settings
    const { mkdirSync, writeFileSync } = require('fs');
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tempDir, '.claude', 'settings.local.json'),
      JSON.stringify({ customSetting: true }),
    );

    const paths = adapter.setupHooks(tempDir, DEFAULT_POLICY, 30000);

    // Should have merged
    const settings = JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
    expect(settings.customSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toBeDefined();

    adapter.cleanupHooks(paths);

    // Should preserve customSetting after cleanup
    expect(existsSync(paths.settingsPath)).toBe(true);
    const restored = JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
    expect(restored.customSetting).toBe(true);
    expect(restored.hooks).toBeUndefined();
  });

  it('installs timeout hook without containment policy (#38)', () => {
    const adapter = new CliAdapter();
    const paths = adapter.setupHooks(tempDir, undefined, 30000);

    // Should have only the timeout hook script (no containment)
    expect(paths.scriptPaths.length).toBe(1);
    expect(paths.scriptPaths[0]).toContain('timeout-hook-');

    // Settings should have exactly one PreToolUse hook (timeout only)
    const settingsPath = join(tempDir, '.claude', 'settings.local.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse.length).toBe(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('timeout-hook-');

    adapter.cleanupHooks(paths);
  });

  it('installs both hooks when containment policy is provided (#38)', () => {
    const adapter = new CliAdapter();
    const paths = adapter.setupHooks(tempDir, DEFAULT_POLICY, 30000);

    expect(paths.scriptPaths.length).toBe(2);
    expect(paths.scriptPaths[0]).toContain('containment-hook-');
    expect(paths.scriptPaths[1]).toContain('timeout-hook-');

    const settingsPath = join(tempDir, '.claude', 'settings.local.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse.length).toBe(2);

    adapter.cleanupHooks(paths);
  });

  it('uses sessionStartTime for marker path so it matches SESSION_START_TIME env var (#37)', () => {
    const adapter = new CliAdapter();
    const fixedTime = 1700000000000;
    const paths = adapter.setupHooks(tempDir, DEFAULT_POLICY, 30000, fixedTime);

    // Marker path should use the same timestamp passed as sessionStartTime
    expect(paths.markerPath).toContain(`timeout-warned-${fixedTime}.marker`);

    // Script filenames should also use this timestamp
    for (const p of paths.scriptPaths) {
      expect(p).toContain(String(fixedTime));
    }

    adapter.cleanupHooks(paths);
  });
});

// --- spawn() integration tests using mocked child_process ---

/**
 * Creates a fake ChildProcess that emits events like a real spawned process.
 * Allows tests to control stdout, stderr, exit code, and error events.
 */
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

// Note: vi.mock is hoisted to file scope by Vitest, so this mock applies to ALL
// describe blocks. Earlier tests don't call child_process.spawn, so no interference.
vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as spawnMock } from 'child_process';

describe('CliAdapter.spawn() (#102)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-spawn-test-'));
    // Fake timers freeze Date.now() — this is acceptable since spawn() uses
    // Date.now() for sessionStartTime and we only assert it's defined, not its value.
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns completed result on exit code 0 with JSON output', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    // Simulate successful JSON output
    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'task done',
      cost_usd: 0.03,
    })));
    mockProc.emit('close', 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe('task done');
      expect(result.value.cost).toBe(0.03);
      expect(result.value.exitStatus).toBe('completed');
    }
  });

  it('returns failed result on non-zero exit code', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'partial output',
      cost_usd: 0.01,
    })));
    mockProc.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitStatus).toBe('failed');
      expect(result.value.cost).toBe(0.01);
    }
  });

  it('returns rate-limited SessionError when stderr contains rate limit signal', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'partial',
      cost_usd: 0.02,
    })));
    mockProc.stderr.emit('data', Buffer.from('Error: rate limit exceeded'));
    mockProc.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).rateLimited).toBe(true);
      expect((result.error as SessionError).cost).toBe(0.02);
    }
  });

  it('returns rate-limited SessionError when stdout contains rate limit signal', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    mockProc.stdout.emit('data', Buffer.from('HTTP 429 Too Many Requests'));
    mockProc.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as SessionError).rateLimited).toBe(true);
    }
  });

  it('returns timed-out result when timeout fires', async () => {
    const shortTimeoutDef = { ...mockDef, timeoutMs: 500 };
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(shortTimeoutDef, 'slow work', { cwd: tempDir });

    // Emit partial output before timeout
    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'partial work [HANDOFF]pick up at step 3[/HANDOFF]',
      cost_usd: 0.04,
    })));

    // Advance timer to trigger timeout — sends SIGTERM first
    vi.advanceTimersByTime(600);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    // Process exits gracefully after SIGTERM (before SIGKILL grace period)
    mockProc.emit('close', null);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitStatus).toBe('timed-out');
      expect(result.value.cost).toBe(0.04);
      expect(result.value.handoffNote).toBe('pick up at step 3');
    }
  });

  it('sends SIGTERM then SIGKILL after grace period on timeout (#42)', async () => {
    const shortTimeoutDef = { ...mockDef, timeoutMs: 500 };
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(shortTimeoutDef, 'stubborn work', { cwd: tempDir });

    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'partial',
      cost_usd: 0.01,
    })));

    // Trigger timeout — should send SIGTERM first
    vi.advanceTimersByTime(600);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Advance past the 5-second grace period — SIGKILL should fire
    vi.advanceTimersByTime(5_000);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

    // Process finally exits after SIGKILL
    mockProc.emit('close', null);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitStatus).toBe('timed-out');
    }
  });

  it('returns SessionError with cost on process error event', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    // Emit some stdout before error
    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: 'started',
      cost_usd: 0.01,
    })));
    mockProc.emit('error', new Error('spawn ENOENT'));

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SessionError);
      expect(result.error.message).toBe('spawn ENOENT');
      expect((result.error as SessionError).cost).toBe(0.01);
    }
  });

  it('sets up hooks with containment policy and cleans them up on close', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const setupSpy = vi.spyOn(adapter, 'setupHooks');
    const cleanupSpy = vi.spyOn(adapter, 'cleanupHooks');

    const promise = adapter.spawn(mockDef, 'do work', {
      cwd: tempDir,
      containmentPolicy: DEFAULT_POLICY,
    });

    expect(setupSpy).toHaveBeenCalledWith(tempDir, DEFAULT_POLICY, mockDef.timeoutMs, expect.any(Number));

    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockProc.emit('close', 0);

    await promise;
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('cleans up hooks on error event', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const cleanupSpy = vi.spyOn(adapter, 'cleanupHooks');

    const promise = adapter.spawn(mockDef, 'do work', {
      cwd: tempDir,
      containmentPolicy: DEFAULT_POLICY,
    });

    mockProc.emit('error', new Error('ENOENT'));
    await promise;
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('passes SESSION_START_TIME and SESSION_TIMEOUT_MS in env', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    const spawnCall = vi.mocked(spawnMock).mock.calls[0];
    const env = (spawnCall?.[2] as { env: Record<string, string> })?.env;
    expect(env?.SESSION_START_TIME).toBeDefined();
    expect(env?.SESSION_TIMEOUT_MS).toBe(String(mockDef.timeoutMs));

    mockProc.stdout.emit('data', Buffer.from('{}'));
    mockProc.emit('close', 0);
  });

  it('extracts pitfall markers from output', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const promise = adapter.spawn(mockDef, 'do work', { cwd: tempDir });

    const output = JSON.stringify({
      result: 'done <!-- PITFALL: {"artifactPatterns":["src/**"],"description":"watch out for X"} --> more',
      cost_usd: 0.01,
    });
    mockProc.stdout.emit('data', Buffer.from(output));
    mockProc.emit('close', 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pitfallMarkers).toHaveLength(1);
      expect(result.value.pitfallMarkers[0]?.description).toBe('watch out for X');
    }
  });

  it('skips hook setup when cwd is not provided', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawnMock).mockReturnValue(mockProc as never);

    const adapter = new CliAdapter();
    const setupSpy = vi.spyOn(adapter, 'setupHooks');

    const promise = adapter.spawn(mockDef, 'do work');

    mockProc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockProc.emit('close', 0);

    await promise;
    expect(setupSpy).not.toHaveBeenCalled();
  });
});
