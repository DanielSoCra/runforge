// src/coordination/tech-lead/metrics.ts — Time-series metrics computation with retention
import { readJsonSafe, writeJsonSafe } from '../../lib/json-store.js';
import { MetricDataPointSchema, type MetricDataPoint } from './schemas.js';
import { z } from 'zod';

const MetricsFileSchema = z.array(MetricDataPointSchema);

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface MetricsDeps {
  /** Count of review findings with completed work requests / total findings */
  getFindingToFixRate: () => Promise<number | null>;
  /** Count of drift items resolved since last cycle */
  getDriftReduction: () => Promise<number | null>;
  /** Ms between first failure and proposal creation for detected patterns */
  getFailureDetectionSpeed: () => Promise<number | null>;
  /** Ratio of records sharing root-cause tags over total records */
  getRepeatGotchaRate: () => Promise<number | null>;
  /** Ms between advisory appearance and proposal creation */
  getDependencyResponseTime: () => Promise<number | null>;
}

export async function computeAndStoreMetrics(
  metricsPath: string,
  deps: MetricsDeps,
  retentionMs: number = DEFAULT_RETENTION_MS,
): Promise<MetricDataPoint> {
  // Compute all metrics in parallel — failures return null
  const [findingToFixRate, driftReduction, failureDetectionSpeedMs, repeatGotchaRate, dependencyResponseTimeMs] =
    await Promise.all([
      deps.getFindingToFixRate().catch(() => null),
      deps.getDriftReduction().catch(() => null),
      deps.getFailureDetectionSpeed().catch(() => null),
      deps.getRepeatGotchaRate().catch(() => null),
      deps.getDependencyResponseTime().catch(() => null),
    ]);

  const dataPoint: MetricDataPoint = {
    timestamp: new Date().toISOString(),
    findingToFixRate,
    driftReduction,
    failureDetectionSpeedMs,
    repeatGotchaRate,
    dependencyResponseTimeMs,
  };

  // Load existing, apply retention, append new
  const existing = await loadMetrics(metricsPath);
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const retained = existing.filter(m => m.timestamp >= cutoff);
  retained.push(dataPoint);

  await writeJsonSafe(metricsPath, retained);
  return dataPoint;
}

export async function loadMetrics(metricsPath: string): Promise<MetricDataPoint[]> {
  const result = await readJsonSafe<unknown>(metricsPath);
  if (!result.ok) return [];
  const parsed = MetricsFileSchema.safeParse(result.value);
  return parsed.success ? parsed.data : [];
}
