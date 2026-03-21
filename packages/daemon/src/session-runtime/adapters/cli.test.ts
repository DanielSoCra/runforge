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

describe('CliAdapter containment hook setup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-adapter-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .claude/settings.local.json with PreToolUse hook', () => {
    const adapter = new CliAdapter();
    const paths = adapter.setupContainmentHook(tempDir, DEFAULT_POLICY);

    // Hook script should exist
    expect(existsSync(paths.scriptPath)).toBe(true);

    // Settings file should exist with hook config
    const settingsPath = join(tempDir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('node "');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(paths.scriptPath);

    adapter.cleanupContainmentHook(paths);
  });

  it('cleans up hook script and settings after cleanup', () => {
    const adapter = new CliAdapter();
    const paths = adapter.setupContainmentHook(tempDir, DEFAULT_POLICY);

    adapter.cleanupContainmentHook(paths);

    // Hook script should be deleted
    expect(existsSync(paths.scriptPath)).toBe(false);

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

    const paths = adapter.setupContainmentHook(tempDir, DEFAULT_POLICY);

    // Should have merged
    const settings = JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
    expect(settings.customSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toBeDefined();

    adapter.cleanupContainmentHook(paths);

    // Should preserve customSetting after cleanup
    expect(existsSync(paths.settingsPath)).toBe(true);
    const restored = JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
    expect(restored.customSetting).toBe(true);
    expect(restored.hooks).toBeUndefined();
  });
});
