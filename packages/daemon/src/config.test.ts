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
    }
  });

  it('rejects invalid adapter', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, adapter: 'invalid' });
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
    const result = ConfigSchema.safeParse({ dailyBudget: 50, perRunBudget: 10 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual({ staging: 'staging', production: 'main' });
      expect(result.data.validation.maxFixCycles).toBe(3);
      expect(result.data.diagnosis.confidenceThreshold).toBe(0.7);
      expect(result.data.warmup.threshold).toBe(10);
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
