// src/session-runtime/adapters/cli.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CliAdapter } from './cli.js';
import { DEFAULT_POLICY } from '../containment-hooks.js';
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
