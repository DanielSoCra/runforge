// src/session-runtime/adapters/cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliAdapter } from './cli.js';
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

  it('includes --allowedTools when provided', () => {
    const adapter = new CliAdapter();
    const args = adapter.buildArgs(mockDef, 'prompt');
    expect(args).toContain('--allowedTools');
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
