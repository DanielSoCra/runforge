// src/coordination/tech-lead/metrics.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeAndStoreMetrics, loadMetrics, type MetricsDeps } from './metrics.js';
import { writeJsonSafe } from '../../lib/json-store.js';

function makeDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    getFindingToFixRate: vi.fn().mockResolvedValue(0.75),
    getDriftReduction: vi.fn().mockResolvedValue(3),
    getFailureDetectionSpeed: vi.fn().mockResolvedValue(3600000),
    getRepeatGotchaRate: vi.fn().mockResolvedValue(0.1),
    getDependencyResponseTime: vi.fn().mockResolvedValue(86400000),
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tl-metrics-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('computeAndStoreMetrics', () => {
  it('computes and stores a data point', async () => {
    const path = join(tmpDir, 'metrics.json');
    const deps = makeDeps();

    const point = await computeAndStoreMetrics(path, deps);

    expect(point.findingToFixRate).toBe(0.75);
    expect(point.driftReduction).toBe(3);
    expect(point.timestamp).toBeTruthy();

    const loaded = await loadMetrics(path);
    expect(loaded).toHaveLength(1);
  });

  it('handles null metrics when deps fail', async () => {
    const path = join(tmpDir, 'metrics.json');
    const deps = makeDeps({
      getFindingToFixRate: vi.fn().mockRejectedValue(new Error('fail')),
      getDriftReduction: vi.fn().mockRejectedValue(new Error('fail')),
    });

    const point = await computeAndStoreMetrics(path, deps);

    expect(point.findingToFixRate).toBeNull();
    expect(point.driftReduction).toBeNull();
    expect(point.failureDetectionSpeedMs).toBe(3600000); // other deps succeed
  });

  it('applies retention window', async () => {
    const path = join(tmpDir, 'metrics.json');
    const old = {
      timestamp: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(), // 200 days ago
      findingToFixRate: 0.5,
      driftReduction: null,
      failureDetectionSpeedMs: null,
      repeatGotchaRate: null,
      dependencyResponseTimeMs: null,
    };
    await writeJsonSafe(path, [old]);

    await computeAndStoreMetrics(path, makeDeps());

    const loaded = await loadMetrics(path);
    // Old point should be evicted, only new point remains
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.findingToFixRate).toBe(0.75);
  });

  it('appends to existing metrics within retention', async () => {
    const path = join(tmpDir, 'metrics.json');
    const recent = {
      timestamp: new Date(Date.now() - 1000).toISOString(),
      findingToFixRate: 0.5,
      driftReduction: null,
      failureDetectionSpeedMs: null,
      repeatGotchaRate: null,
      dependencyResponseTimeMs: null,
    };
    await writeJsonSafe(path, [recent]);

    await computeAndStoreMetrics(path, makeDeps());

    const loaded = await loadMetrics(path);
    expect(loaded).toHaveLength(2);
  });
});

describe('loadMetrics', () => {
  it('returns empty for non-existent file', async () => {
    const result = await loadMetrics(join(tmpDir, 'nope.json'));
    expect(result).toEqual([]);
  });

  it('returns empty for invalid JSON', async () => {
    const path = join(tmpDir, 'bad.json');
    await writeJsonSafe(path, 'not an array');
    const result = await loadMetrics(path);
    expect(result).toEqual([]);
  });
});
