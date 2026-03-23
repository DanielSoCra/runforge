import { z } from 'zod';
import { readFile } from 'fs/promises';
import { ok, err, type Result } from './lib/result.js';
import { validateGate1Command } from './validation/gates.js';

// zod v4 requires .default() on nested objects to include explicit values
// matching the inner field defaults. Keep these in sync when changing defaults.
export const ConfigSchema = z.object({
  repo: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
  }).optional(),
  controlPort: z.number().int().min(1024).max(65535).default(3847),
  controlHost: z.string().regex(/^[\w.:]+$/, 'controlHost must be a valid IP or hostname').default('127.0.0.1'),
  pollIntervalMs: z.number().int().min(5000).default(30000),
  maxConcurrentRuns: z.number().int().min(1).default(1),
  dailyBudget: z.number().positive().default(50),
  perRunBudget: z.number().positive().default(10),
  adapter: z.enum(['cli', 'sdk']).default('cli'),
  branches: z.object({
    staging: z.string().default('staging'),
    production: z.string().default('main'),
  }).default({ staging: 'staging', production: 'main' }),
  webhooks: z.array(z.string().url()).default([]),
  validation: z.object({
    gate1Commands: z.array(
      z.string().refine(
        (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
        { message: 'Gate1 command contains disallowed shell characters' },
      ),
    ).default(['vitest run', 'tsc --noEmit', 'eslint --max-warnings 0 src/']),
    maxFixCycles: z.number().int().min(1).default(3),
    holdoutCommand: z.string().refine(
      (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
      { message: 'Holdout command contains disallowed shell characters' },
    ).optional(),
    staticAnalysis: z.object({
      maxComplexity: z.number().int().default(15),
      maxFunctionLength: z.number().int().default(50),
      maxFileSize: z.number().int().default(500),
    }).default({ maxComplexity: 15, maxFunctionLength: 50, maxFileSize: 500 }),
    diminishingReturns: z.object({
      minCycles: z.number().int().min(1).default(2),
      improvementThreshold: z.number().min(0).max(1).default(0.2),
    }).default({ minCycles: 2, improvementThreshold: 0.2 }),
    deployCommand: z.string().refine(
      (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
      { message: 'Deploy command contains disallowed shell characters' },
    ).optional(),
    healthCheckUrl: z.string().url().optional(),
    healthCheckIntervalMs: z.number().int().min(1000).default(5000),
    deployTimeoutMs: z.number().int().min(5000).default(120000),
    maxDeployAttempts: z.number().int().min(1).default(2),
    testCommands: z.array(
      z.string().refine(
        (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
        { message: 'Test command contains disallowed shell characters' },
      ),
    ).default([]),
    maxTestFixAttempts: z.number().int().min(1).default(3),
    failureExcerptLines: z.number().int().min(10).default(50),
  }).default({
    gate1Commands: ['vitest run', 'tsc --noEmit', 'eslint --max-warnings 0 src/'],
    maxFixCycles: 3,
    staticAnalysis: { maxComplexity: 15, maxFunctionLength: 50, maxFileSize: 500 },
    diminishingReturns: { minCycles: 2, improvementThreshold: 0.2 },
    healthCheckIntervalMs: 5000,
    deployTimeoutMs: 120000,
    maxDeployAttempts: 2,
    testCommands: [],
    maxTestFixAttempts: 3,
    failureExcerptLines: 50,
  }),
  diagnosis: z.object({
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
  }).default({ confidenceThreshold: 0.7 }),
  warmup: z.object({
    threshold: z.number().int().min(1).default(10),
    regressionThreshold: z.number().int().min(1).default(3),
    samplingRate: z.number().min(0.01).max(1).default(0.1),
    minSamplingRate: z.number().min(0.01).max(1).default(0.01),
  }).default({ threshold: 10, regressionThreshold: 3, samplingRate: 0.1, minSamplingRate: 0.01 }),
  maxConsecutiveStuck: z.number().int().min(1).default(3),
  gracePeriodMs: z.number().int().default(30000),
  activePlugins: z.array(z.string()).default([]),
  knowledge: z.object({
    systemicProposalThreshold: z.number().int().min(1).default(3),
    systemicProposalCooldownDays: z.number().int().min(1).default(30),
    candidateTimeoutDays: z.number().int().min(1).default(14),
    prospectiveSeverityThreshold: z.number().int().min(1).default(5),
  }).default({
    systemicProposalThreshold: 3,
    systemicProposalCooldownDays: 30,
    candidateTimeoutDays: 14,
    prospectiveSeverityThreshold: 5,
  }),
  coordination: z.object({
    maxAgents: z.number().int().min(1).default(10),
    reviewerInterval: z.number().int().min(60000).default(3600000),
    poInterval: z.number().int().min(60000).default(3600000),
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
  }).default({
    maxAgents: 10,
    reviewerInterval: 3600000,
    poInterval: 3600000,
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
  }),
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
