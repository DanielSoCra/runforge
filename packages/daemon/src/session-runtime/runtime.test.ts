// src/session-runtime/runtime.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRuntime, loadPromptTemplate } from './runtime.js';
import { CostTracker } from './cost.js';
import { RateLimiter } from './rate-limiter.js';
import type { Config } from '../config.js';
import { buildCompositeContext } from './plugin-injection.js';
import { SessionError } from './session-error.js';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __clearGovernanceCacheForTests } from './governance-context.js';

const mockCaptureScopeBaseCommit = vi.hoisted(() =>
  vi.fn().mockResolvedValue('base-sha'),
);
const mockAuditScope = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: undefined }),
);

vi.mock('./plugin-loader.js', () => ({
  readPluginsForContext: vi.fn().mockResolvedValue([
    {
      id: 'test',
      activatedAt: '2024-01-01T00:00:00Z',
      promptInjection: 'PLUGIN INJECTION',
      skills: [
        { name: 'skill.md', content: 'SKILL CONTENT', pluginId: 'test' },
      ],
      agents: [
        { name: 'agent.md', content: 'AGENT CONTENT', pluginId: 'test' },
      ],
      mcpConfigs: [],
      gates: [],
    },
  ]),
}));

const mockSpawn = vi
  .fn()
  .mockResolvedValue({ ok: true, value: { output: '', cost: 0.05 } });
vi.mock('./adapters/index.js', () => ({
  createAdapter: vi.fn(() => ({
    spawn: mockSpawn,
  })),
}));

vi.mock('./scope-audit.js', () => ({
  captureScopeBaseCommit: mockCaptureScopeBaseCommit,
  auditScope: mockAuditScope,
}));

// Minimal config for testing
const testConfig = {
  adapter: 'cli' as const,
  dailyBudget: 50,
  perRunBudget: 10,
  governance: {
    documentPath: 'FACTORY_RULES.md',
    maxPrLinesChanged: 900,
  },
} as Config;

// Full variable set for the registered worker prompt contract
// (task, specs, verification, pitfalls — pitfalls has default ''; the others
// must be present or assertContract throws in test mode).
const WORKER_VARS = {
  task: 'do it',
  specs: '',
  verification: '',
  pitfalls: '',
};

describe('SessionRuntime', () => {
  let runtime: SessionRuntime;
  let costTracker: CostTracker;
  let governanceDir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    governanceDir = await mkdtemp(join(tmpdir(), 'runtime-governance-'));
    process.chdir(governanceDir);
    await writeFile(
      join(governanceDir, 'FACTORY_RULES.md'),
      '# FACTORY_RULES\n\nDaily {{dailyBudget}}\nRun {{perRunBudget}}\nMax {{maxPrLinesChanged}}',
    );
    __clearGovernanceCacheForTests();
    mockSpawn.mockClear();
    mockCaptureScopeBaseCommit.mockClear();
    mockCaptureScopeBaseCommit.mockResolvedValue('base-sha');
    mockAuditScope.mockClear();
    mockAuditScope.mockResolvedValue({ ok: true, value: undefined });
    costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    runtime = new SessionRuntime(testConfig, costTracker);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    __clearGovernanceCacheForTests();
    await rm(governanceDir, { recursive: true, force: true });
  });

  it('rejects unknown session types', async () => {
    const result = await runtime.spawnSession(
      'unknown-type' as any,
      { variables: {} },
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain('No agent definition');
  });

  it('spawns product-owner session type without error (#342)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '{}', cost: 0.02 },
    });
    const result = await runtime.spawnSession(
      'product-owner',
      { variables: {} },
      1,
    );
    expect(result.ok).toBe(true);
  });

  it('spawns tech-lead session type without error (#342)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '{}', cost: 0.02 },
    });
    const result = await runtime.spawnSession(
      'tech-lead',
      { variables: {} },
      1,
    );
    expect(result.ok).toBe(true);
  });

  it('product-owner has read-only tools (#342)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '{}', cost: 0.01 },
    });
    await runtime.spawnSession('product-owner', { variables: {} }, 1);
    const calledDef = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1]![0];
    expect(calledDef.allowedTools).not.toContain('Write');
    expect(calledDef.allowedTools).not.toContain('Edit');
    expect(calledDef.allowedTools).not.toContain('Bash');
  });

  it('tech-lead has read-only tools (#342)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '{}', cost: 0.01 },
    });
    await runtime.spawnSession('tech-lead', { variables: {} }, 1);
    const calledDef = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1]![0];
    expect(calledDef.allowedTools).not.toContain('Write');
    expect(calledDef.allowedTools).not.toContain('Edit');
    expect(calledDef.allowedTools).not.toContain('Bash');
  });

  it('does not define a reporter agent — reports are generated directly (#54)', async () => {
    // The reporter prompt template and agent definition were dead code:
    // phases.ts calls formatReport() directly, no session is spawned.
    // Attempting to spawn a reporter session should fail with "No agent definition".
    const result = await runtime.spawnSession(
      'reporter' as any,
      { variables: {} },
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain('No agent definition');
  });

  it('rejects when daily budget exceeded with SessionError', async () => {
    costTracker.recordCost(1, 51);
    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS },
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Budget exceeded');
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).cost).toBe(0);
    }
  });

  it('rejects when per-run budget exceeded with SessionError', async () => {
    costTracker.recordCost(1, 11);
    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS },
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Budget exceeded');
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).cost).toBe(0);
    }
  });

  it('assembles prompt with context variables', async () => {
    // Access private method via any for testing
    const result = await (runtime as any).assemblePrompt(
      { name: 'test-agent', systemPrompt: 'Base prompt' },
      { variables: { task: 'do something', specs: 'spec content' } },
    );
    expect(result.prompt).toContain('Base prompt');
    expect(result.prompt).toContain('## task');
    expect(result.prompt).toContain('do something');
    expect(result.prompt).toContain('## specs');
    expect(result.prompt).toContain('spec content');
  });

  it('includes plugin skills and agents before system prompt', async () => {
    const result = await (runtime as any).assemblePrompt(
      { name: 'test-agent', systemPrompt: 'SYSTEM PROMPT' },
      {
        variables: {},
        activePlugins: [{ id: 'test', activatedAt: '2024-01-01T00:00:00Z' }],
      },
    );
    expect(result.prompt).toContain('SKILL CONTENT');
    expect(result.prompt).toContain('AGENT CONTENT');
    expect(result.prompt).toContain('PLUGIN INJECTION');
    expect(result.prompt.indexOf('PLUGIN INJECTION')).toBeLessThan(
      result.prompt.indexOf('SYSTEM PROMPT'),
    );
    expect(result.prompt.indexOf('SKILL CONTENT')).toBeLessThan(
      result.prompt.indexOf('SYSTEM PROMPT'),
    );
    expect(result.prompt.indexOf('AGENT CONTENT')).toBeLessThan(
      result.prompt.indexOf('SYSTEM PROMPT'),
    );
  });

  it('prepends governance before plugins and system prompt', async () => {
    const result = await (runtime as any).assemblePrompt(
      { name: 'test-agent', systemPrompt: 'SYSTEM PROMPT' },
      {
        variables: {},
        activePlugins: [{ id: 'test', activatedAt: '2024-01-01T00:00:00Z' }],
      },
    );

    expect(result.prompt).toContain('# FACTORY_RULES');
    expect(result.prompt).toContain('Daily $50');
    expect(result.prompt.indexOf('# FACTORY_RULES')).toBeLessThan(
      result.prompt.indexOf('PLUGIN INJECTION'),
    );
    expect(result.prompt.indexOf('# FACTORY_RULES')).toBeLessThan(
      result.prompt.indexOf('SYSTEM PROMPT'),
    );
  });

  it('returns an error instead of spawning when governance cannot load', async () => {
    mockSpawn.mockClear();
    const missingConfig = {
      ...testConfig,
      governance: { documentPath: 'missing-rules.md', maxPrLinesChanged: 900 },
    } as Config;
    const missingRuntime = new SessionRuntime(missingConfig, costTracker);

    const result = await missingRuntime.spawnSession(
      'worker',
      { variables: WORKER_VARS },
      1,
    );

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain('governance document not found');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('composite context prompt injection appears before system prompt', () => {
    const ctx = buildCompositeContext([
      {
        id: 'test',
        activatedAt: '2024-01-01T00:00:00Z',
        promptInjection: 'PLUGIN INJECTION',
        skills: [],
        agents: [],
        mcpConfigs: [],
        gates: [],
      },
    ]);
    const systemPrompt = 'SYSTEM PROMPT';
    const assembled = [ctx.promptInjection, systemPrompt]
      .filter(Boolean)
      .join('\n\n---\n\n');
    expect(assembled.indexOf('PLUGIN INJECTION')).toBeLessThan(
      assembled.indexOf('SYSTEM PROMPT'),
    );
  });

  it('serializes object jsonSchema to string before adapter.spawn (Codex 057caeb)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '', cost: 0.01 },
    });
    const schema = {
      type: 'object',
      properties: { nested: { type: 'array', items: { type: 'string' } } },
      required: ['nested'],
    };
    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      99,
      { jsonSchema: schema },
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ jsonSchema: JSON.stringify(schema) }),
    );
  });

  it('passes through string jsonSchema unchanged to adapter.spawn', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '', cost: 0.01 },
    });
    const schemaString = '{"type":"object"}';
    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      99,
      { jsonSchema: schemaString },
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ jsonSchema: schemaString }),
    );
  });

  it('passes containmentPolicy to adapter.spawn', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '', cost: 0.01 },
    });
    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
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

  it('passes resolved directory scope to adapter.spawn', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: '', cost: 0.01 },
    });
    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      99,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        directoryScope: expect.objectContaining({
          writePaths: ['src/**', 'packages/**', 'tests/**'],
          denyPaths: expect.arrayContaining(['.specify/scenarios/**']),
        }),
      }),
    );
  });

  it('returns scopeViolation SessionError when post-session scope audit fails', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: 'done', cost: 0.01 },
    });
    mockAuditScope.mockResolvedValueOnce({
      ok: false,
      error: [
        {
          sessionId: 'worker-99',
          agentType: 'worker',
          path: 'README.md',
          violationType: 'write-outside-permitted',
          detectionLayer: 'post-session',
          timestamp: '2026-05-04T00:00:00.000Z',
        },
      ],
    });

    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      99,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).scopeViolation).toBe(true);
      expect((result.error as SessionError).containmentBreach).toBe(true);
    }
  });

  it('calls runWriter.writeCostEvent after a successful session', async () => {
    const writeCostEvent = vi.fn().mockResolvedValue(undefined);
    const runWriter = { writeCostEvent, upsertRun: vi.fn() } as any;

    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp', activePlugins: [] },
      42,
      undefined,
      runWriter,
      'my-run-id',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(writeCostEvent).toHaveBeenCalledWith(
        'my-run-id',
        'worker',
        expect.any(Number),
      );
    }
  });

  it('allocates one session cost across multiple issue numbers (#470)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: {
        output: '',
        structuredData: {},
        cost: 0.3,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    await runtime.spawnSession(
      'classifier',
      { variables: { workRequest: '', specRefs: 'none', scope: '' } },
      1,
      { costAttributionIssueNumbers: [1, 2, 3] },
    );

    expect(costTracker.getDailyCost()).toBe(0.3);
    expect(costTracker.getRunCost(1)).toBeCloseTo(0.1);
    expect(costTracker.getRunCost(2)).toBeCloseTo(0.1);
    expect(costTracker.getRunCost(3)).toBeCloseTo(0.1);
  });

  it('records cost even when session fails with SessionError (#13)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new SessionError('CLI crashed', 0.42),
    });

    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp' },
      77,
    );

    expect(costTracker.getDailyCost()).toBe(0.42);
    expect(costTracker.getRunCost(77)).toBe(0.42);
  });

  it('records cost from failed session to runWriter (#13)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new SessionError('CLI crashed', 1.5),
    });
    const writeCostEvent = vi.fn().mockResolvedValue(undefined);
    const runWriter = { writeCostEvent, upsertRun: vi.fn() } as any;

    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp' },
      88,
      undefined,
      runWriter,
      'run-123',
    );

    expect(writeCostEvent).toHaveBeenCalledWith('run-123', 'worker', 1.5);
    expect(costTracker.getDailyCost()).toBe(1.5);
  });

  it('does not record cost when failure has zero cost', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new SessionError('spawn failed', 0),
    });

    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp' },
      99,
    );

    expect(costTracker.getDailyCost()).toBe(0);
    expect(costTracker.getRunCost(99)).toBe(0);
  });

  it('does not record cost when failure is a plain Error', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new Error('unknown error'),
    });

    await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp' },
      100,
    );

    expect(costTracker.getDailyCost()).toBe(0);
    expect(costTracker.getRunCost(100)).toBe(0);
  });

  it('rejects when rate limited (cooldown active) with rateLimited flag', async () => {
    const rateLimiter = new RateLimiter({
      baseBackoffMs: 60000,
      maxBackoffMs: 300000,
    });
    rateLimiter.reportRateLimit(); // activate cooldown
    const rl = new SessionRuntime(testConfig, costTracker, rateLimiter);

    const result = await rl.spawnSession(
      'worker',
      { variables: WORKER_VARS },
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Rate limited');
      // Must be a SessionError with rateLimited=true so control plane can distinguish
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).rateLimited).toBe(true);
    }
  });

  it('reports rate limit to limiter when adapter returns rateLimited error', async () => {
    const rateLimiter = new RateLimiter({
      baseBackoffMs: 1000,
      maxBackoffMs: 60000,
    });
    const rl = new SessionRuntime(testConfig, costTracker, rateLimiter);

    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new SessionError('Rate limited by upstream provider', 0.1, true),
    });

    await rl.spawnSession('worker', { variables: WORKER_VARS }, 42);

    // Rate limiter should now be in cooldown
    const check = rateLimiter.checkRateLimit();
    expect(check.clear).toBe(false);
    expect(rateLimiter.getConsecutiveCount()).toBe(1);
  });

  it('does not activate rate limiter for non-rate-limit errors', async () => {
    const rateLimiter = new RateLimiter();
    const rl = new SessionRuntime(testConfig, costTracker, rateLimiter);

    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new SessionError('Some other error', 0.1, false),
    });

    await rl.spawnSession('worker', { variables: WORKER_VARS }, 42);

    const check = rateLimiter.checkRateLimit();
    expect(check.clear).toBe(true);
  });

  it('does not flag path references in output after path scanning removal (#222)', async () => {
    // Path scanning was removed — preventive hooks handle write blocking.
    // Output that merely mentions blocked paths should pass audit.
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: {
        output:
          'I read the file .specify/scenarios/secret.md and found test data',
        cost: 0.03,
      },
    });

    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      50,
    );

    expect(result.ok).toBe(true);
  });

  it('does not flag containment breach when session output is clean (#222)', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: {
        output: 'Successfully implemented the feature in src/index.ts',
        cost: 0.02,
      },
    });

    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      51,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toContain('Successfully implemented');
    }
  });

  it('passes plugin mcpConfigs to adapter.spawn (#314)', async () => {
    const { readPluginsForContext } = await import('./plugin-loader.js');
    (readPluginsForContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'figma-plugin',
        activatedAt: '2024-01-01T00:00:00Z',
        promptInjection: '',
        skills: [],
        agents: [],
        mcpConfigs: [
          {
            name: 'figma-mcp',
            command: 'npx',
            args: ['figma-mcp-server'],
            env: { TOKEN: 'abc' },
          },
        ],
        gates: ['pnpm run lint'],
      },
    ]);

    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: 'done', cost: 0.01 },
    });
    await runtime.spawnSession(
      'worker',
      {
        variables: WORKER_VARS,
        workspacePath: '/tmp/ws',
        activePlugins: [
          { id: 'figma-plugin', activatedAt: '2024-01-01T00:00:00Z' },
        ],
      },
      200,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        mcpConfigs: [
          expect.objectContaining({ name: 'figma-mcp', command: 'npx' }),
        ],
      }),
    );
  });

  it('returns plugin gates in session result (#314)', async () => {
    const { readPluginsForContext } = await import('./plugin-loader.js');
    (readPluginsForContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'lint-plugin',
        activatedAt: '2024-01-01T00:00:00Z',
        promptInjection: '',
        skills: [],
        agents: [],
        mcpConfigs: [],
        gates: ['pnpm run lint', 'pnpm run typecheck'],
      },
    ]);

    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: 'done', cost: 0.01 },
    });
    const result = await runtime.spawnSession(
      'worker',
      {
        variables: WORKER_VARS,
        workspacePath: '/tmp/ws',
        activePlugins: [
          { id: 'lint-plugin', activatedAt: '2024-01-01T00:00:00Z' },
        ],
      },
      201,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pluginGates).toEqual([
        'pnpm run lint',
        'pnpm run typecheck',
      ]);
    }
  });

  it('assemblePrompt returns mcpConfigs and gates from plugins (#314)', async () => {
    const { readPluginsForContext } = await import('./plugin-loader.js');
    (readPluginsForContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'test-plugin',
        activatedAt: '2024-01-01T00:00:00Z',
        promptInjection: '',
        skills: [],
        agents: [],
        mcpConfigs: [
          { name: 'test-mcp', command: 'node', args: ['server.js'] },
        ],
        gates: ['npm test'],
      },
    ]);

    const result = await (runtime as any).assemblePrompt(
      { name: 'test-agent', systemPrompt: 'PROMPT' },
      {
        variables: {},
        activePlugins: [
          { id: 'test-plugin', activatedAt: '2024-01-01T00:00:00Z' },
        ],
      },
    );

    expect(result.mcpConfigs).toHaveLength(1);
    expect(result.mcpConfigs[0].name).toBe('test-mcp');
    expect(result.gates).toEqual(['npm test']);
  });

  it('assemblePrompt returns empty mcpConfigs and gates without plugins (#314)', async () => {
    const result = await (runtime as any).assemblePrompt(
      { name: 'test-agent', systemPrompt: 'PROMPT' },
      { variables: {} },
    );

    expect(result.mcpConfigs).toEqual([]);
    expect(result.gates).toEqual([]);
    expect(result.prompt).toContain('PROMPT');
  });

  it('path references in output no longer trigger containment breach (#222)', async () => {
    // Path scanning removed — preventive hooks handle this
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: {
        output: 'Accessed state/runs/42.json for debugging',
        cost: 0.07,
      },
    });

    const result = await runtime.spawnSession(
      'worker',
      { variables: WORKER_VARS, workspacePath: '/tmp/ws' },
      52,
    );

    expect(result.ok).toBe(true);
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
    // Using an unregistered synthetic prompt name so the contract registry doesn't apply
    await writeFile(
      join(tmpDir, 'test-loader.md'),
      '# Worker\n\nTask: {{task}}\nSpecs: {{specs}}',
    );
    const result = await loadPromptTemplate('test-loader', {
      task: 'build feature',
      specs: 'FUNC-1',
    });
    expect(result).toBe('# Worker\n\nTask: build feature\nSpecs: FUNC-1');
  });

  it('returns null when template file does not exist', async () => {
    const result = await loadPromptTemplate('nonexistent', {});
    expect(result).toBeNull();
  });

  it('returns template unchanged when no variables match placeholders', async () => {
    await writeFile(
      join(tmpDir, 'classifier.md'),
      '# Classifier\n\nNo placeholders here.',
    );
    const result = await loadPromptTemplate('classifier', { unused: 'value' });
    expect(result).toBe('# Classifier\n\nNo placeholders here.');
  });

  it('replaces all occurrences of the same placeholder', async () => {
    await writeFile(
      join(tmpDir, 'test-repeat.md'),
      'Run {{cmd}} then {{cmd}} again',
    );
    const result = await loadPromptTemplate('test-repeat', { cmd: 'vitest' });
    expect(result).toBe('Run vitest then vitest again');
  });

  it('rejects path traversal attempts', async () => {
    expect(await loadPromptTemplate('../../etc/passwd', {})).toBeNull();
    expect(await loadPromptTemplate('foo/bar', {})).toBeNull();
    expect(await loadPromptTemplate('foo\\bar', {})).toBeNull();
  });

  it('leaves unknown placeholders intact (delegates to knowledge/renderTemplate)', async () => {
    await writeFile(
      join(tmpDir, 'test-placeholder.md'),
      'Task: {{task}}\nPitfalls: {{pitfalls}}',
    );
    const result = await loadPromptTemplate('test-placeholder', {
      task: 'build feature',
    });
    expect(result).toBe('Task: build feature\nPitfalls: {{pitfalls}}');
  });

  it('applies defaults for omitted keys when prompt is registered', async () => {
    // Write a minimal l2-designer template that references {{feedback}} so the
    // default-applied substitution is observable.
    await writeFile(
      join(tmpDir, 'l2-designer.md'),
      'Issue {{issueNumber}}: {{issueTitle}}\nBody: {{issueBody}}\n' +
        'Spec: {{specContent}}\nRepo: {{owner}}/{{repo}}\nFeedback: {{feedback}}',
    );
    const out = await loadPromptTemplate('l2-designer', {
      issueNumber: '1',
      issueTitle: 't',
      issueBody: 'b',
      specContent: 's',
      owner: 'o',
      repo: 'r',
    });
    expect(out).not.toBeNull();
    // {{feedback}} should have been substituted with the default (empty string)
    expect(out).not.toMatch(/\{\{feedback\}\}/);
  });

  it('throws when caller passes an unknown variable to a registered prompt (test mode)', async () => {
    await expect(
      loadPromptTemplate('l2-designer', {
        issueNumber: '1',
        issueTitle: 't',
        issueBody: 'b',
        specContent: 's',
        owner: 'o',
        repo: 'r',
        feedback: '',
        surprise: 'x',
      } as Record<string, string>),
    ).rejects.toThrow(/unknown variable.*surprise/);
  });

  it('throws when caller omits a required variable for a registered prompt (test mode)', async () => {
    await expect(
      loadPromptTemplate('compliance-reviewer', {
        issueNumber: '1',
        repo: 'r',
      } as Record<string, string>),
    ).rejects.toThrow(/missing required variable/);
  });

  it('leaves unregistered prompts unchanged (legacy behavior)', async () => {
    // test-unregistered is not in PROMPT_CONTRACTS — caller can pass anything
    await writeFile(
      join(tmpDir, 'test-unregistered.md'),
      'Task: {{task}}\nSpecs: {{specs}}',
    );
    const out = await loadPromptTemplate('test-unregistered', {
      task: 'x',
      specs: 'y',
    });
    expect(out).not.toBeNull();
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
    await writeFile(
      join(tmpDir, 'worker.md'),
      '# Worker\n\nYou implement {{task}} per {{specs}}.\nVerify: {{verification}}\n{{pitfalls}}',
    );
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(
      { adapter: 'cli', dailyBudget: 50, perRunBudget: 10 } as Config,
      costTracker,
    );
    const result = await (runtime as any).assemblePrompt(
      { name: 'worker', systemPrompt: '' },
      {
        variables: {
          task: 'add auth',
          specs: 'FUNC-AC-SAFETY',
          verification: 'pnpm test',
          pitfalls: '',
        },
      },
    );
    expect(result.prompt).toContain('# Worker');
    expect(result.prompt).toContain(
      'You implement add auth per FUNC-AC-SAFETY.',
    );
    // Must NOT contain the old appended-variable format when template is loaded
    expect(result.prompt).not.toContain('## task');
  });

  it('falls back to systemPrompt + appended variables when template is missing', async () => {
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(
      { adapter: 'cli', dailyBudget: 50, perRunBudget: 10 } as Config,
      costTracker,
    );
    const result = await (runtime as any).assemblePrompt(
      { name: 'nonexistent-agent', systemPrompt: 'Fallback prompt' },
      { variables: { task: 'do something' } },
    );
    expect(result.prompt).toContain('Fallback prompt');
    expect(result.prompt).toContain('## task');
    expect(result.prompt).toContain('do something');
  });
});

describe('post-session output audit (advisory) — #489', () => {
  it('does NOT terminate the session when output prose mentions blocked command names', async () => {
    // Reproduces the failure mode that stuck #480: model output legitimately
    // discusses git/bash/python3 in prose, which the regex flags as evidence.
    // Pre-fix: returned err(SessionError, containmentBreached=true) → terminal.
    // Post-fix: warning recorded on result.value.auditWarnings, session continues.
    const proseWithBlockedNames = `
Here is what I plan to do next:

  $ git status
  $ bash deploy.sh
  python3 -V

These are reference examples; I will not execute them.
`;
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: { output: proseWithBlockedNames, cost: 0.05 },
    });

    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(testConfig, costTracker);
    const result = await runtime.spawnSession(
      'product-owner',
      { variables: {} },
      1,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Warnings recorded — but session continues
      expect(result.value.auditWarnings).toBeDefined();
      expect(result.value.auditWarnings!.length).toBeGreaterThan(0);
      expect(result.value.auditWarnings!.some((v) => v.includes("'git'"))).toBe(
        true,
      );
    }
  });

  it('does NOT set auditWarnings when output is clean prose with no command patterns', async () => {
    mockSpawn.mockResolvedValueOnce({
      ok: true,
      value: {
        output: 'I added a helper function to format strings.',
        cost: 0.01,
      },
    });
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(testConfig, costTracker);
    const result = await runtime.spawnSession(
      'product-owner',
      { variables: {} },
      1,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.auditWarnings).toBeUndefined();
    }
  });

  it('preserves session error when adapter itself fails (audit only runs on success)', async () => {
    // Confirms that real session errors (e.g., from preventive Bash-hook
    // containment in adapters/cli.ts) still propagate as terminal — the
    // post-session audit is non-terminal but does not mask actual failures.
    mockSpawn.mockResolvedValueOnce({
      ok: false,
      error: new SessionError(
        'hook denied: git push to forbidden remote',
        0.01,
        false,
        true,
      ),
    });
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const runtime = new SessionRuntime(testConfig, costTracker);
    const result = await runtime.spawnSession(
      'product-owner',
      { variables: {} },
      1,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).containmentBreach).toBe(true);
    }
  });
});
