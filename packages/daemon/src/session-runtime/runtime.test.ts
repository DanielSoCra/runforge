// src/session-runtime/runtime.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRuntime, loadPromptTemplate } from './runtime.js';
import { CostTracker } from './cost.js';
import type { Config } from '../config.js';
import { buildCompositeContext } from './plugin-injection.js';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('./plugin-loader.js', () => ({
  readPluginsForContext: vi.fn().mockResolvedValue([{
    id: 'test',
    activatedAt: '2024-01-01T00:00:00Z',
    promptInjection: 'PLUGIN INJECTION',
    skills: [{ name: 'skill.md', content: 'SKILL CONTENT', pluginId: 'test' }],
    agents: [{ name: 'agent.md', content: 'AGENT CONTENT', pluginId: 'test' }],
    mcpConfigs: [],
    gates: [],
  }]),
}));

const mockSpawn = vi.fn().mockResolvedValue({ ok: true, value: { output: '', cost: 0.05 } });
vi.mock('./adapters/index.js', () => ({
  createAdapter: vi.fn(() => ({
    spawn: mockSpawn,
  })),
}));

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
      { name: 'test-agent', systemPrompt: 'Base prompt' },
      { variables: { task: 'do something', specs: 'spec content' } },
    );
    expect(assembled).toContain('Base prompt');
    expect(assembled).toContain('## task');
    expect(assembled).toContain('do something');
    expect(assembled).toContain('## specs');
    expect(assembled).toContain('spec content');
  });

  it('includes plugin skills and agents before system prompt', async () => {
    const assembled = await (runtime as any).assemblePrompt(
      { name: 'test-agent', systemPrompt: 'SYSTEM PROMPT' },
      { variables: {}, activePlugins: [{ id: 'test', activatedAt: '2024-01-01T00:00:00Z' }] },
    );
    expect(assembled).toContain('SKILL CONTENT');
    expect(assembled).toContain('AGENT CONTENT');
    expect(assembled).toContain('PLUGIN INJECTION');
    expect(assembled.indexOf('PLUGIN INJECTION')).toBeLessThan(assembled.indexOf('SYSTEM PROMPT'));
    expect(assembled.indexOf('SKILL CONTENT')).toBeLessThan(assembled.indexOf('SYSTEM PROMPT'));
    expect(assembled.indexOf('AGENT CONTENT')).toBeLessThan(assembled.indexOf('SYSTEM PROMPT'));
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

  it('passes containmentPolicy to adapter.spawn', async () => {
    mockSpawn.mockResolvedValueOnce({ ok: true, value: { output: '', cost: 0.01 } });
    await runtime.spawnSession(
      'worker',
      { variables: { task: 'do it' }, workspacePath: '/tmp/ws' },
      99,
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        containmentPolicy: expect.objectContaining({
          blockedPaths: expect.arrayContaining(['.specify/scenarios/**']),
          blockedCommands: expect.arrayContaining(['curl ']),
          readOnlyPaths: expect.arrayContaining(['.specify/**']),
        }),
      }),
    );
  });

  it('calls runWriter.writeCostEvent after a successful session', async () => {
    const writeCostEvent = vi.fn().mockResolvedValue(undefined);
    const runWriter = { writeCostEvent, upsertRun: vi.fn() } as any;

    const result = await runtime.spawnSession(
      'worker',
      { variables: { task: 'do it' }, workspacePath: '/tmp', activePlugins: [] },
      42,
      undefined,
      runWriter,
      'my-run-id',
    );

    if (result.ok) {
      expect(writeCostEvent).toHaveBeenCalledWith('my-run-id', 'worker', expect.any(Number));
    }
  });
});

describe('loadPromptTemplate', () => {
  let tmpDir: string;
  const originalEnv = process.env['PROMPTS_DIR'];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'prompt-test-'));
    process.env['PROMPTS_DIR'] = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env['PROMPTS_DIR'];
    } else {
      process.env['PROMPTS_DIR'] = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads template from prompts/{name}.md and substitutes {{variables}}', async () => {
    await writeFile(join(tmpDir, 'worker.md'), '# Worker\n\nTask: {{task}}\nSpecs: {{specs}}');
    const result = await loadPromptTemplate('worker', { task: 'build feature', specs: 'FUNC-1' });
    expect(result).toBe('# Worker\n\nTask: build feature\nSpecs: FUNC-1');
  });

  it('returns null when template file does not exist', async () => {
    const result = await loadPromptTemplate('nonexistent', {});
    expect(result).toBeNull();
  });

  it('returns template unchanged when no variables match placeholders', async () => {
    await writeFile(join(tmpDir, 'classifier.md'), '# Classifier\n\nNo placeholders here.');
    const result = await loadPromptTemplate('classifier', { unused: 'value' });
    expect(result).toBe('# Classifier\n\nNo placeholders here.');
  });

  it('replaces all occurrences of the same placeholder', async () => {
    await writeFile(join(tmpDir, 'tester.md'), 'Run {{cmd}} then {{cmd}} again');
    const result = await loadPromptTemplate('tester', { cmd: 'vitest' });
    expect(result).toBe('Run vitest then vitest again');
  });

  it('rejects path traversal attempts', async () => {
    expect(await loadPromptTemplate('../../etc/passwd', {})).toBeNull();
    expect(await loadPromptTemplate('foo/bar', {})).toBeNull();
    expect(await loadPromptTemplate('foo\\bar', {})).toBeNull();
  });
});

describe('SessionRuntime prompt assembly with templates', () => {
  let tmpDir: string;
  const originalEnv = process.env['PROMPTS_DIR'];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'prompt-asm-'));
    process.env['PROMPTS_DIR'] = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env['PROMPTS_DIR'];
    } else {
      process.env['PROMPTS_DIR'] = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('assemblePrompt loads template instead of using empty systemPrompt', async () => {
    await writeFile(join(tmpDir, 'worker.md'), '# Worker\n\nYou implement {{task}} per {{specs}}.');
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(
      { adapter: 'cli', dailyBudget: 50, perRunBudget: 10 } as Config,
      costTracker,
    );
    const assembled = await (runtime as any).assemblePrompt(
      { name: 'worker', systemPrompt: '' },
      { variables: { task: 'add auth', specs: 'FUNC-AC-SAFETY' } },
    );
    expect(assembled).toContain('# Worker');
    expect(assembled).toContain('You implement add auth per FUNC-AC-SAFETY.');
    // Must NOT contain the old appended-variable format when template is loaded
    expect(assembled).not.toContain('## task');
  });

  it('falls back to systemPrompt + appended variables when template is missing', async () => {
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(
      { adapter: 'cli', dailyBudget: 50, perRunBudget: 10 } as Config,
      costTracker,
    );
    const assembled = await (runtime as any).assemblePrompt(
      { name: 'nonexistent-agent', systemPrompt: 'Fallback prompt' },
      { variables: { task: 'do something' } },
    );
    expect(assembled).toContain('Fallback prompt');
    expect(assembled).toContain('## task');
    expect(assembled).toContain('do something');
  });
});
