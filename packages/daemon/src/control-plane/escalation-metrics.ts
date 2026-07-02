// src/control-plane/escalation-metrics.ts — Escalation-rate metric aggregation
//
// Mirrors the deps-injected, retention-shaped pattern of
// coordination/tech-lead/metrics.ts: flat JSON time-series under state/metrics,
// read/write via writeJsonSafe/readJsonSafe, 90-day rolling window.
import { join } from 'node:path';
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';
import type { EscalationCountBucket } from '@auto-claude/decision-index';
import type { HandlerResult } from './decision-api.js';

export interface EscalationMetricEvent {
  ts: string;
  deploymentId: string;
  issueNumber?: number;
}

export interface EscalationTrendInput {
  raisedEvents: Array<{ ts: string | number; deploymentId: string }>;
  answeredEvents: Array<{ ts: string | number; deploymentId: string }>;
  autoMergeEvents: Array<{ ts: string | number; deploymentId: string }>;
}

export interface EscalationTrendOptions {
  weeks: number;
}

export interface EscalationTrendRow {
  weekStart: string;
  deploymentId: string;
  raised: number;
  answered: number;
  autoMerges: number;
  operatorTouchesPerDelivered: number | null;
}

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_WEEKS = 4;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseTs(ts: string | number): Date {
  return typeof ts === 'number' ? new Date(ts) : new Date(ts);
}

/** Monday-week start for a given timestamp (ISO 8601 week). */
function weekStart(ts: string | number): string {
  const date = parseTs(ts);
  const day = date.getUTCDay();
  const mondayOffset = (day + 6) % 7; // 0=Mon, …, 6=Sun
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return isoDate(monday);
}

function currentWeekStart(): string {
  return weekStart(new Date().toISOString());
}

function weekStarts(weeks: number): string[] {
  const starts: string[] = [];
  const current = new Date(`${currentWeekStart()}T00:00:00.000Z`);
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(current);
    d.setUTCDate(current.getUTCDate() - i * 7);
    starts.push(isoDate(d));
  }
  return starts;
}

function bucketEvents(
  events: Array<{ ts: string | number; deploymentId: string }>,
  targetWeeks: Set<string>,
): Map<string, Map<string, number>> {
  const buckets = new Map<string, Map<string, number>>();
  for (const event of events) {
    const ws = weekStart(event.ts);
    if (!targetWeeks.has(ws)) continue;
    if (!buckets.has(ws)) buckets.set(ws, new Map());
    const byDeployment = buckets.get(ws)!;
    byDeployment.set(event.deploymentId, (byDeployment.get(event.deploymentId) ?? 0) + 1);
  }
  return buckets;
}

/**
 * Compute weekly per-deployment escalation trend rows.
 *
 * - Weeks are Monday-aligned ISO weeks.
 * - The window is the most recent `weeks` complete weeks ending at the current
 *   week start (inclusive).
 * - `operatorTouchesPerDelivered = answered / (answered + autoMerges)`; null
 *   when zero decisions were delivered (answered + autoMerges === 0).
 */
export function computeEscalationTrend(
  input: EscalationTrendInput,
  opts: EscalationTrendOptions,
): EscalationTrendRow[] {
  const starts = weekStarts(opts.weeks);
  const targetWeeks = new Set(starts);

  const raised = bucketEvents(input.raisedEvents, targetWeeks);
  const answered = bucketEvents(input.answeredEvents, targetWeeks);
  const autoMerges = bucketEvents(input.autoMergeEvents, targetWeeks);

  const deploymentIds = new Set<string>();
  for (const map of [raised, answered, autoMerges]) {
    for (const byDeployment of map.values()) {
      for (const id of byDeployment.keys()) deploymentIds.add(id);
    }
  }

  const rows: EscalationTrendRow[] = [];
  for (const ws of starts) {
    for (const deploymentId of deploymentIds) {
      const raisedCount = raised.get(ws)?.get(deploymentId) ?? 0;
      const answeredCount = answered.get(ws)?.get(deploymentId) ?? 0;
      const autoMergeCount = autoMerges.get(ws)?.get(deploymentId) ?? 0;
      const delivered = answeredCount + autoMergeCount;
      rows.push({
        weekStart: ws,
        deploymentId,
        raised: raisedCount,
        answered: answeredCount,
        autoMerges: autoMergeCount,
        operatorTouchesPerDelivered: delivered > 0 ? answeredCount / delivered : null,
      });
    }
  }

  return rows;
}

/** Build the durable auto-merge log path under a state directory. */
export function autoMergesMetricsPath(stateDir: string): string {
  return join(stateDir, 'metrics', 'auto-merges.json');
}

/**
 * Append a single auto-merge outcome to the durable escalation-metric log.
 * Fire-and-forget: failures are warned, never thrown, so a metrics write cannot
 * fail the merge phase.
 */
export async function appendAutoMergeEvent(
  stateDir: string,
  event: EscalationMetricEvent,
  retentionMs: number = DEFAULT_RETENTION_MS,
): Promise<void> {
  const path = autoMergesMetricsPath(stateDir);
  try {
    const existing = await loadAutoMergeEvents(path);
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const retained = existing.filter((e) => e.ts >= cutoff);
    retained.push(event);
    await writeJsonSafe(path, retained);
  } catch (e) {
    console.warn(
      '[escalation-metrics] Failed to append auto-merge event:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function loadAutoMergeEvents(path: string): Promise<EscalationMetricEvent[]> {
  const result = await readJsonSafe<unknown>(path);
  if (!result.ok) return [];
  if (!Array.isArray(result.value)) return [];
  return result.value.filter(
    (e): e is EscalationMetricEvent =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { ts?: unknown }).ts === 'string' &&
      typeof (e as { deploymentId?: unknown }).deploymentId === 'string',
  );
}

export interface EscalationMetricsDeps {
  decisionManager: DecisionIndexManager | undefined;
  stateDir: string;
}

function bucketsToEvents(buckets: EscalationCountBucket[]): Array<{ ts: string; deploymentId: string }> {
  const events: Array<{ ts: string; deploymentId: string }> = [];
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.count; i++) {
      events.push({ ts: `${bucket.weekStart}T00:00:00.000Z`, deploymentId: bucket.deployment });
    }
  }
  return events;
}

/**
 * GET /metrics/escalation handler.
 *
 * Reads decision-index counts + the auto-merge log, calls computeEscalationTrend,
 * and returns weekly per-deployment rows. If the decision index is unavailable
 * or throws, degrades to auto-merge-only with `unavailable: true` — never 500.
 */
export async function getEscalationMetrics(
  deps: EscalationMetricsDeps,
  query: URLSearchParams,
): Promise<HandlerResult<{ weeks: EscalationTrendRow[]; deployments?: string[]; unavailable?: boolean }>> {
  const rawWeeks = query.get('weeks');
  const requestedWeeks = rawWeeks !== null ? Number(rawWeeks) : DEFAULT_WEEKS;
  const weeks = Number.isFinite(requestedWeeks) && requestedWeeks > 0 ? requestedWeeks : DEFAULT_WEEKS;
  const deploymentId = query.get('deployment') ?? undefined;

  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);

  let raisedBuckets: EscalationCountBucket[] = [];
  let answeredBuckets: EscalationCountBucket[] = [];
  let unavailable = false;

  try {
    if (deps.decisionManager?.isAvailable() === true) {
      const reader = deps.decisionManager.ledger().reader;
      [raisedBuckets, answeredBuckets] = await Promise.all([
        reader.countCreatedSince(deploymentId, since),
        reader.countAnsweredSince(deploymentId, since),
      ]);
    } else {
      unavailable = true;
    }
  } catch (e) {
    unavailable = true;
    console.warn(
      '[escalation-metrics] Decision-index counts failed; degrading to auto-merge-only:',
      e instanceof Error ? e.message : String(e),
    );
  }

  const autoMergeEvents = await loadAutoMergeEvents(autoMergesMetricsPath(deps.stateDir));
  const scopedAutoMergeEvents =
    deploymentId === undefined
      ? autoMergeEvents
      : autoMergeEvents.filter((e) => e.deploymentId === deploymentId);

  const trend = computeEscalationTrend(
    {
      raisedEvents: bucketsToEvents(raisedBuckets),
      answeredEvents: bucketsToEvents(answeredBuckets),
      autoMergeEvents: scopedAutoMergeEvents,
    },
    { weeks },
  );

  const deployments = deploymentId === undefined
    ? [...new Set(trend.map((r) => r.deploymentId))]
    : undefined;

  return {
    status: 200,
    body: {
      weeks: trend,
      ...(deployments !== undefined ? { deployments } : {}),
      ...(unavailable ? { unavailable: true } : {}),
    },
  };
}
