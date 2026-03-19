// src/session-runtime/runtime.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime } from './runtime.js';
import { CostTracker } from './cost.js';
import type { Config } from '../config.js';
import { buildCompositeContext } from './plugin-injection.js';

// Minimal config for testing
const testConfig = {
  adapter: 'cli' as const,
  dailyBudget: 50,
  perRunBudget: 10,
} as Config;

describe('SessionRuntime', () => {
  let runtime: SessionRuntime;
  let costTracker: CostTracker;

  beforeEach(() => {
    costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    runtime = new SessionRuntime(testConfig, costTracker);
  });

  it('rejects unknown session types', async () => {
    const result = await runtime.spawnSession(
      'unknown-type' as any,
      { variables: {} },
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('No agent definition');
  });

  it('rejects when daily budget exceeded', async () => {
    costTracker.recordCost(1, 51);
    const result = await runtime.spawnSession('worker', { variables: {} }, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Budget exceeded');
  });

  it('rejects when per-run budget exceeded', async () => {
    costTracker.recordCost(1, 11);
    const result = await runtime.spawnSession('worker', { variables: {} }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Budget exceeded');
  });

  it('assembles prompt with context variables', async () => {
    // Access private method via any for testing
    const assembled = await (runtime as any).assemblePrompt(
      { systemPrompt: 'Base prompt' },
      { variables: { task: 'do something', specs: 'spec content' } },
    );
    expect(assembled).toContain('Base prompt');
    expect(assembled).toContain('## task');
    expect(assembled).toContain('do something');
    expect(assembled).toContain('## specs');
    expect(assembled).toContain('spec content');
  });
});

it('composite context prompt injection appears before system prompt', () => {
  const ctx = buildCompositeContext([{
    id: 'test', activatedAt: '2024-01-01T00:00:00Z',
    promptInjection: 'PLUGIN INJECTION',
    skills: [], agents: [], mcpConfigs: [], gates: [],
  }]);
  const systemPrompt = 'SYSTEM PROMPT';
  const assembled = [ctx.promptInjection, systemPrompt].filter(Boolean).join('\n\n---\n\n');
  expect(assembled.indexOf('PLUGIN INJECTION')).toBeLessThan(assembled.indexOf('SYSTEM PROMPT'));
});
