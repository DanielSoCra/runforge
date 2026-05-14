import { z } from 'zod';
import { isIP } from 'node:net';
import { readFile } from 'fs/promises';
import { ok, err, type Result } from './lib/result.js';
import { validateGate1Command } from './validation/gates.js';

const DirectoryScopeSchema = z.object({
  readPaths: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([]),
});

const ModelTierSchema = z.enum([
  'standard-capability',
  'higher-capability',
]);

const ProviderDefinitionSchema = z.object({
  name: z.string().min(1),
  adapterClass: z.enum(['process-based', 'programmatic-api']),
  providerKind: z.enum([
    'claude-cli',
    'codex-cli',
    'pi-cli',
  ]),
  supportedModelTiers: z.array(ModelTierSchema).min(1),
  required: z.boolean().default(false),
  cliTool: z.string().min(1).optional(),
  binaryPath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  executionFlags: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const ProvidersConfigSchema = z.object({
  defaultProvider: z.string().min(1),
  fallbackChain: z.array(z.string().min(1)).default([]),
  definitions: z.record(z.string(), ProviderDefinitionSchema),
});

// zod v4 requires .default() on nested objects to include explicit values
// matching the inner field defaults. Keep these in sync when changing defaults.
export const ConfigSchema = z.object({
  repo: z
    .object({
      owner: z.string().min(1),
      name: z.string().min(1),
    })
    .optional(),
  controlPort: z.number().int().min(1024).max(65535).default(3847),
  controlHost: z
    .string()
    .refine((host) => isIP(host) === 4, {
      message: 'controlHost must be a valid IPv4 address',
    })
    .default('127.0.0.1'),
  pollIntervalMs: z.number().int().min(5000).default(30000),
  maxConcurrentRuns: z.number().int().min(1).default(1),
  classifierBatchSize: z.number().int().min(1).max(100).default(10),
  dailyBudget: z.number().positive().default(50),
  perRunBudget: z.number().positive().default(10),
  adapter: z.enum(['cli', 'sdk']).default('cli'),
  providers: ProvidersConfigSchema.optional(),
  branches: z
    .object({
      staging: z.string().default('staging'),
      production: z.string().default('main'),
    })
    .default({ staging: 'staging', production: 'main' }),
  webhooks: z.array(z.string().url()).default([]),
  validation: z
    .object({
      gate1Commands: z
        .array(
          z
            .string()
            .refine(
              (cmd: string) =>
                !cmd.trim() || validateGate1Command(cmd) === null,
              { message: 'Gate1 command contains disallowed shell characters' },
            ),
        )
        .default([
          'vitest run',
          'tsc --noEmit',
          'eslint --max-warnings 0 src/',
        ]),
      maxFixCycles: z.number().int().min(1).default(3),
      holdoutCommand: z
        .string()
        .refine(
          (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
          { message: 'Holdout command contains disallowed shell characters' },
        )
        .optional(),
      staticAnalysis: z
        .object({
          maxComplexity: z.number().int().default(15),
          maxFunctionLength: z.number().int().default(50),
          maxFileSize: z.number().int().default(500),
        })
        .default({
          maxComplexity: 15,
          maxFunctionLength: 50,
          maxFileSize: 500,
        }),
      diminishingReturns: z
        .object({
          minCycles: z.number().int().min(1).default(2),
          improvementThreshold: z.number().min(0).max(1).default(0.2),
        })
        .default({ minCycles: 2, improvementThreshold: 0.2 }),
      deployCommand: z
        .string()
        .refine(
          (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
          { message: 'Deploy command contains disallowed shell characters' },
        )
        .optional(),
      healthCheckUrl: z.string().url().optional(),
      healthCheckIntervalMs: z.number().int().min(1000).default(5000),
      deployTimeoutMs: z.number().int().min(5000).default(120000),
      maxDeployAttempts: z.number().int().min(1).default(2),
      testCommands: z
        .array(
          z
            .string()
            .refine(
              (cmd: string) =>
                !cmd.trim() || validateGate1Command(cmd) === null,
              { message: 'Test command contains disallowed shell characters' },
            ),
        )
        .default([]),
      maxTestFixAttempts: z.number().int().min(1).default(3),
      failureExcerptLines: z.number().int().min(10).default(50),
      proactiveIntervalMs: z.number().int().min(60000).default(1200000),
      proactiveAreas: z.array(z.string()).optional(),
      proactiveMaxConcurrent: z.number().int().min(1).default(1),
      proactiveThrottleThreshold: z.number().min(0).max(1).default(0.8),
      proactiveRecentCommits: z.number().int().min(1).default(20),
    })
    .default({
      gate1Commands: [
        'vitest run',
        'tsc --noEmit',
        'eslint --max-warnings 0 src/',
      ],
      maxFixCycles: 3,
      staticAnalysis: {
        maxComplexity: 15,
        maxFunctionLength: 50,
        maxFileSize: 500,
      },
      diminishingReturns: { minCycles: 2, improvementThreshold: 0.2 },
      healthCheckIntervalMs: 5000,
      deployTimeoutMs: 120000,
      maxDeployAttempts: 2,
      testCommands: [],
      maxTestFixAttempts: 3,
      failureExcerptLines: 50,
      proactiveIntervalMs: 1200000,
      proactiveMaxConcurrent: 1,
      proactiveThrottleThreshold: 0.8,
      proactiveRecentCommits: 20,
    }),
  diagnosis: z
    .object({
      confidenceThreshold: z.number().min(0).max(1).default(0.7),
    })
    .default({ confidenceThreshold: 0.7 }),
  warmup: z
    .object({
      threshold: z.number().int().min(1).default(10),
      regressionThreshold: z.number().int().min(1).default(3),
      samplingRate: z.number().min(0.01).max(1).default(0.1),
      minSamplingRate: z.number().min(0.01).max(1).default(0.01),
    })
    .default({
      threshold: 10,
      regressionThreshold: 3,
      samplingRate: 0.1,
      minSamplingRate: 0.01,
    }),
  maxConsecutiveStuck: z.number().int().min(1).default(30),
  gracePeriodMs: z.number().int().default(30000),
  maxRunsPerIssue: z.number().int().min(1).default(3),
  retryBackoffBaseMs: z.number().int().min(1000).default(60_000),
  retryBackoffMaxMs: z.number().int().min(10_000).default(1_800_000),
  governance: z
    .object({
      documentPath: z.string().min(1).default('FACTORY_RULES.md'),
      maxPrLinesChanged: z.number().int().min(1).default(2000),
    })
    .default({ documentPath: 'FACTORY_RULES.md', maxPrLinesChanged: 2000 }),
  agentScopes: z.record(z.string(), DirectoryScopeSchema).default({}),
  activePlugins: z.array(z.string()).default([]),
  knowledge: z
    .object({
      systemicProposalThreshold: z.number().int().min(1).default(3),
      systemicProposalCooldownDays: z.number().int().min(1).default(30),
      candidateTimeoutDays: z.number().int().min(1).default(14),
      prospectiveSeverityThreshold: z.number().int().min(1).default(5),
      knowledgePolicies: z
        .record(
          z.string(),
          z.object({
            promotionThreshold: z.number().int().min(1).optional(),
            promotionMaxAgeDays: z.number().min(1).optional(),
            archivalMaxAgeDays: z.number().min(0).optional(),
            archivalMinHitCount: z.number().int().min(0).optional(),
            injectionTargets: z.array(z.string()).optional(),
            sortOrder: z
              .enum(['priority_then_hits', 'recency', 'severity_then_recency'])
              .optional(),
          }),
        )
        .optional(),
    })
    .default({
      systemicProposalThreshold: 3,
      systemicProposalCooldownDays: 30,
      candidateTimeoutDays: 14,
      prospectiveSeverityThreshold: 5,
    }),
  knowledgeSync: z
    .object({
      enabled: z.boolean().default(false),
      vaultPath: z.string().min(1),
      syncIntervalMinutes: z.number().int().positive().default(60),
    })
    .optional(),
  coordination: z
    .object({
      useCoordinator: z.boolean().default(false),
      tickInterval: z.number().int().min(1000).default(5000),
      maxAgents: z.number().int().min(1).default(10),
      reviewerInterval: z.number().int().min(60000).default(3600000),
      poInterval: z.number().int().min(60000).default(3600000),
      poIdeaDebounce: z.number().int().min(10000).default(300000),
      poFindingDailyCap: z.number().int().min(1).default(5),
      plannerTimeout: z.number().int().min(10000).default(60000),
      maxAttemptsPerIssue: z.number().int().min(1).default(3),
      diskSpaceThreshold: z.number().int().min(0).default(2_000_000_000),
      gcInterval: z.number().int().min(60000).default(600000),
      conflictFileThreshold: z.number().int().min(1).default(3),
      conflictLineThreshold: z.number().int().min(1).default(100),
      mergeDependencyTimeout: z.number().int().min(60000).default(1800000),
      mergeValidationTimeout: z.number().int().min(60000).default(600000),
      mergePollInterval: z.number().int().min(1000).default(5000),
      mergePollMaxInterval: z.number().int().min(5000).default(60000),
      techLeadInterval: z.number().int().min(60000).default(7200000),
      techLeadEventDebounce: z.number().int().min(10000).default(300000),
      techLeadProposalExpiryMs: z
        .number()
        .int()
        .min(60000)
        .default(7 * 24 * 60 * 60 * 1000),
      techLeadLookbackWindowMs: z
        .number()
        .int()
        .min(60000)
        .default(48 * 60 * 60 * 1000),
      techLeadMaxEntriesPerSection: z.number().int().min(1).default(50),
      maxConsecutiveTickErrors: z.number().int().min(1).default(5),
    })
    .default({
      useCoordinator: false,
      tickInterval: 5000,
      maxAgents: 10,
      reviewerInterval: 3600000,
      poInterval: 3600000,
      poIdeaDebounce: 300000,
      poFindingDailyCap: 5,
      plannerTimeout: 60000,
      maxAttemptsPerIssue: 3,
      diskSpaceThreshold: 2_000_000_000,
      gcInterval: 600000,
      conflictFileThreshold: 3,
      conflictLineThreshold: 100,
      mergeDependencyTimeout: 1800000,
      mergeValidationTimeout: 600000,
      mergePollInterval: 5000,
      mergePollMaxInterval: 60000,
      techLeadInterval: 7200000,
      techLeadEventDebounce: 300000,
      techLeadProposalExpiryMs: 7 * 24 * 60 * 60 * 1000,
      techLeadLookbackWindowMs: 48 * 60 * 60 * 1000,
      techLeadMaxEntriesPerSection: 50,
      maxConsecutiveTickErrors: 5,
    }),
}).superRefine((config, ctx) => {
  const providers = config.providers;
  if (!providers) return;

  const names = new Set(Object.keys(providers.definitions));
  if (!names.has(providers.defaultProvider)) {
    ctx.addIssue({
      code: 'custom',
      path: ['providers', 'defaultProvider'],
      message: `defaultProvider must reference a registered provider: ${providers.defaultProvider}`,
    });
  }

  for (const [name, definition] of Object.entries(providers.definitions)) {
    if (definition.name !== name) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'definitions', name, 'name'],
        message: `provider definition name must match registry key: ${name}`,
      });
    }
  }

  providers.fallbackChain.forEach((name, index) => {
    if (!names.has(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'fallbackChain', index],
        message: `fallback provider must reference a registered provider: ${name}`,
      });
    }
  });
});

export type Config = z.infer<typeof ConfigSchema>;

export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  budgetLimit: number | null;
  concurrencyLimit: number;
  activePlugins: Array<{ id: string; activatedAt: string }>;
}

export interface GlobalConfig {
  concurrencyLimit: number;
  dailyBudgetLimit: number | null;
  defaultModel: string;
}

export async function loadConfig(path: string): Promise<Result<Config>> {
  try {
    const raw = await readFile(path, 'utf-8');
    const json = JSON.parse(raw);
    const result = ConfigSchema.safeParse(json);
    if (result.success) return ok(result.data);
    return err(new Error(`Config validation failed: ${result.error.message}`));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
