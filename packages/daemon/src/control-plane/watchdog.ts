// B5 work-loop watchdog (first-use safety net) — DETECT a stalled work loop and
// hand the daemon a single "self-pause + notify + flip /health to 503" signal.
//
// CRITICAL SAFETY (Codex CRITICAL 2): the watchdog DETECTS only. It never
// decrements `activeRuns`, never cancels the live run, and never force-releases
// the held concurrency slot. Decrementing while the original run promise is still
// alive risks a double-decrement, overlapping work, and a stuck-marked run that
// keeps mutating GitHub/state. The held slot is recovered by operator restart (or
// the deferred B5-cancel follow-up), NOT here. By construction this module has no
// access to the run-count, so the safety property is structural, not incidental.
import type { Result } from '../lib/result.js';
import type { PollerSnapshot } from './repo-manager.js';

/** Per-active-run progress sample (T2.4b): persisted `updatedAt`, epoch-ms. */
export interface ActiveRunProgress {
  issue: number;
  /** Epoch-ms of the run's last durable progress write, or null if unknown. */
  lastUpdatedAt: number | null;
}

/** Inputs the watchdog evaluates each tick. */
export interface WatchdogSignals {
  activeRunProgress: ActiveRunProgress[];
  pollerSnapshots: PollerSnapshot[];
}

/** A detected stall — surfaced to the daemon's onStall callback. */
export interface WatchdogStall {
  kind: 'run-stall' | 'tick-stall';
  detail: string;
  /** Epoch-ms the stall was detected. */
  detectedAt: number;
}

/**
 * Pure detector. Returns the first stall found (run-stall takes precedence over
 * tick-stall) or null. Detection is strictly-greater-than the idle-timeout so a
 * run exactly at the boundary is not flagged. A null/unknown progress timestamp
 * is never treated as stalled (we cannot prove no progress).
 */
export function evaluateWatchdog(
  signals: WatchdogSignals,
  now: number,
  idleTimeoutMs: number,
): WatchdogStall | null {
  for (const run of signals.activeRunProgress) {
    if (run.lastUpdatedAt === null) continue;
    const idleFor = now - run.lastUpdatedAt;
    if (idleFor > idleTimeoutMs) {
      return {
        kind: 'run-stall',
        detail: `run #${run.issue} has not progressed for ${idleFor}ms (> idle-timeout ${idleTimeoutMs}ms)`,
        detectedAt: now,
      };
    }
  }
  for (const poll of signals.pollerSnapshots) {
    if (!poll.pollInProgress || poll.pollStartedAt === null) continue;
    const inFlightFor = now - poll.pollStartedAt;
    if (inFlightFor > idleTimeoutMs) {
      return {
        kind: 'tick-stall',
        detail: `repo ${poll.repoId} (${poll.owner}/${poll.name}) poll has not settled for ${inFlightFor}ms (> idle-timeout ${idleTimeoutMs}ms)`,
        detectedAt: now,
      };
    }
  }
  return null;
}

export interface WatchdogDeps {
  now: () => number;
  idleTimeoutMs: number;
  readSignals: () => Promise<WatchdogSignals>;
  isPaused: () => boolean;
  isShuttingDown: () => boolean;
  /**
   * Invoked exactly once per stall episode. The daemon implementation self-pauses
   * (pauseReason='stuck'), records the stall for /health, and notifies the
   * Operator once. It must NOT touch the run-count (see file header). Because
   * onStall flips paused=true, the next tick short-circuits at isPaused() — that
   * is the notify-once mechanism (no internal latch needed).
   */
  onStall: (stall: WatchdogStall) => void;
}

/**
 * Periodic watchdog. Each `tick()`:
 *  - no-ops while shutting down/draining or already paused (so it never fires on
 *    top of an existing pause, and never double-notifies);
 *  - otherwise reads the live signals and, on a detected stall, invokes onStall.
 */
export function createWatchdog(deps: WatchdogDeps): { tick: () => Promise<void> } {
  return {
    async tick(): Promise<void> {
      if (deps.isShuttingDown() || deps.isPaused()) return;
      const signals = await deps.readSignals();
      const stall = evaluateWatchdog(signals, deps.now(), deps.idleTimeoutMs);
      if (stall !== null) deps.onStall(stall);
    },
  };
}

/**
 * Read each active issue's persisted progress timestamp (T2.4b). The primary
 * mechanism: `loadRunState(issue).updatedAt` (saveRunState persists `updatedAt`
 * on every durable progress write — state.ts:22), so there is no separate
 * in-memory registry to keep in sync. A load failure or unparseable timestamp
 * yields `lastUpdatedAt: null` (never treated as stalled by evaluateWatchdog).
 */
export async function readActiveRunProgress(
  activeIssues: Iterable<number>,
  loadRunState: (issue: number) => Promise<Result<{ updatedAt?: string }>>,
): Promise<ActiveRunProgress[]> {
  const out: ActiveRunProgress[] = [];
  for (const issue of activeIssues) {
    let lastUpdatedAt: number | null = null;
    try {
      const result = await loadRunState(issue);
      if (result.ok && typeof result.value.updatedAt === 'string') {
        const parsed = Date.parse(result.value.updatedAt);
        lastUpdatedAt = Number.isNaN(parsed) ? null : parsed;
      }
    } catch {
      lastUpdatedAt = null;
    }
    out.push({ issue, lastUpdatedAt });
  }
  return out;
}
