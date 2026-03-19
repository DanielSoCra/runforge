import { describe, it, expect } from 'vitest';
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

  it('rejects missing repo', () => {
    const { repo, ...rest } = validConfig;
    const result = ConfigSchema.safeParse(rest);
    expect(result.success).toBe(false);
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

describe('loadConfig', () => {
  it('loads and validates a config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(validConfig));
    const result = await loadConfig(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repo.owner).toBe('test-owner');
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
    await writeFile(path, JSON.stringify({ invalid: true }));
    const result = await loadConfig(path);
    expect(result.ok).toBe(false);
  });
});
