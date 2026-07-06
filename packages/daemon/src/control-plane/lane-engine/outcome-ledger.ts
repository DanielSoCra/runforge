// packages/daemon/src/control-plane/lane-engine/outcome-ledger.ts
// Raw per-(deployment, lane) outcome stream: clean merges, bounces, red events.
// Owned by STACK-AC-LANE-ENGINE; earn-in derives its floor-relevant track record
// over this stream.

import { join } from 'node:path';
import { readJsonSafe, writeJsonSafe } from '../../lib/json-store.js';
import type { BounceReason, LaneOutcome, RedEventKind } from '../earn-in/types.js';
import type { RiskLevel } from './types.js';

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function laneOutcomesPath(stateDir: string): string {
  return join(stateDir, 'metrics', 'lane-outcomes.json');
}

function isValidBounceReason(reason: unknown): reason is BounceReason {
  return reason === 'scope-tripwire' || reason === 'failed-check' || reason === 'review-block' || reason === 'operator-send-back';
}

function isValidRedReason(reason: unknown): reason is RedEventKind {
  return (
    reason === 'red-risk-merge' ||
    reason === 'batch-review-high-severity' ||
    reason === 'post-merge-tripwire' ||
    reason === 'failed-release' ||
    reason === 'compliance-breach'
  );
}

function isValidRiskClass(level: unknown): level is RiskLevel {
  return level === 'green' || level === 'yellow' || level === 'orange' || level === 'red';
}

function isValidOutcome(o: unknown): o is LaneOutcome {
  if (typeof o !== 'object' || o === null) return false;
  const e = o as Record<string, unknown>;
  if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) return false;
  if (typeof e.deploymentId !== 'string' || e.deploymentId.length === 0) return false;
  if (typeof e.lane !== 'string' || e.lane.length === 0) return false;
  if (e.kind !== 'clean-merge' && e.kind !== 'bounce' && e.kind !== 'red') return false;
  if (e.bounceReason !== undefined && !isValidBounceReason(e.bounceReason)) return false;
  if (e.redReason !== undefined && !isValidRedReason(e.redReason)) return false;
  if (e.riskClass !== undefined && !isValidRiskClass(e.riskClass)) return false;
  if (e.issueNumber !== undefined && typeof e.issueNumber !== 'number') return false;
  return true;
}

/**
 * Load and validate lane outcomes from `path`. Malformed entries are dropped.
 * A missing file returns an empty array.
 */
export async function loadLaneOutcomes(path: string): Promise<LaneOutcome[]> {
  const result = await readJsonSafe<unknown>(path);
  if (!result.ok) return [];
  if (!Array.isArray(result.value)) return [];
  return result.value.filter(isValidOutcome);
}

/**
 * Append a lane outcome to the durable log. Fire-and-forget: failures are warned
 * and never thrown, so a metrics write cannot fail the integrate phase.
 */
export async function appendLaneOutcome(
  stateDir: string,
  event: LaneOutcome,
  retentionMs: number = DEFAULT_RETENTION_MS,
): Promise<void> {
  const path = laneOutcomesPath(stateDir);
  try {
    const existing = await loadLaneOutcomes(path);
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const retained = existing.filter((e) => e.ts >= cutoff);
    retained.push(event);
    await writeJsonSafe(path, retained);
  } catch (e) {
    console.warn(
      '[lane-outcomes] Failed to append lane outcome:',
      e instanceof Error ? e.message : String(e),
    );
  }
}
