import { z } from 'zod';
import { readFile } from 'fs/promises';
import { ok, err, type Result } from './lib/result.js';

export const ConfigSchema = z.object({
  repo: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
  }).optional(),
  controlPort: z.number().int().min(1024).max(65535).default(3847),
  pollIntervalMs: z.number().int().min(5000).default(30000),
  maxConcurrentRuns: z.number().int().min(1).default(1),
  dailyBudget: z.number().positive().default(50),
  perRunBudget: z.number().positive().default(10),
  adapter: z.enum(['cli', 'sdk']).default('cli'),
  branches: z.object({
    staging: z.string().default('staging'),
    production: z.string().default('main'),
  }).default({}),
  webhooks: z.array(z.string().url()).default([]),
  validation: z.object({
    gate1Commands: z.array(z.string()).default(['vitest run', 'tsc --noEmit', 'eslint --max-warnings 0 src/']),
    maxFixCycles: z.number().int().min(1).default(3),
    holdoutCommand: z.string().optional(),
    staticAnalysis: z.object({
      maxComplexity: z.number().int().default(15),
      maxFunctionLength: z.number().int().default(50),
      maxFileSize: z.number().int().default(500),
    }).default({}),
  }).default({}),
  diagnosis: z.object({
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
  }).default({}),
  warmup: z.object({
    threshold: z.number().int().min(1).default(10),
    regressionThreshold: z.number().int().min(1).default(3),
    samplingRate: z.number().min(0.01).max(1).default(0.1),
    minSamplingRate: z.number().min(0.01).max(1).default(0.01),
  }).default({}),
  gracePeriodMs: z.number().int().default(30000),
  activePlugins: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

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
