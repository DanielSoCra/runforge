/**
 * ActivityEvent extraction.
 *
 * Compares current signal state against the previous Briefing's
 * signal_snapshot to detect state transitions, merges, and errors.
 */

import type { SignalResult } from './signals.js';

export type ActivityEventType =
  | 'state-transition'
  | 'merge'
  | 'error'
  | 'heartbeat'
  | 'completion';

export type ActivitySeverity = 'info' | 'warning' | 'error';

export interface ActivityEventInsert {
  occurred_at: string;
  event_type: ActivityEventType;
  severity: ActivitySeverity;
  summary: string;
  links: { label: string; url: string }[];
}

export interface PreviousSnapshot {
  runs?: Record<string, unknown>[];
  gitLog?: string[];
  [key: string]: unknown;
}

/**
 * Extract ActivityEvents by comparing current signals to the previous snapshot.
 */
export function extractActivityEvents(
  signals: SignalResult,
  previousSnapshot?: PreviousSnapshot | null,
): ActivityEventInsert[] {
  const events: ActivityEventInsert[] = [];
  const now = new Date().toISOString();

  // --- Run state transitions ---
  const transitionRunIds = new Set<string>();
  const transitions = detectRunTransitions(signals.runs, previousSnapshot?.runs ?? [], now);
  for (const t of transitions) {
    const match = t.summary.match(/^Run (\S+)/);
    if (match) transitionRunIds.add(match[1]);
  }
  events.push(...transitions);

  // --- Merges from git log ---
  events.push(...detectMerges(signals.gitLog, previousSnapshot?.gitLog ?? [], now));

  // --- Errors from stuck runs (skip those already captured as transitions) ---
  events.push(...detectErrors(signals.runs, now, transitionRunIds));

  return events;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectRunTransitions(
  currentRuns: Record<string, unknown>[],
  previousRuns: Record<string, unknown>[],
  now: string,
): ActivityEventInsert[] {
  const events: ActivityEventInsert[] = [];
  const prevById = new Map<string, Record<string, unknown>>();

  for (const run of previousRuns) {
    const id = run.id as string | undefined;
    if (id) prevById.set(id, run);
  }

  for (const run of currentRuns) {
    const id = run.id as string | undefined;
    if (!id) continue;

    const prev = prevById.get(id);
    if (!prev) {
      // New run not in previous snapshot
      events.push({
        occurred_at: (run.updated_at as string) ?? now,
        event_type: 'state-transition',
        severity: 'info',
        summary: `Run ${id} started (issue #${run.issue_number ?? 'unknown'})`,
        links: buildRunLinks(run),
      });
      continue;
    }

    // Check for outcome change
    if (run.outcome && run.outcome !== prev.outcome) {
      const severity: ActivitySeverity =
        run.outcome === 'stuck' ? 'error' : run.outcome === 'success' ? 'info' : 'warning';
      const eventType: ActivityEventType =
        run.outcome === 'stuck' ? 'error' : run.outcome === 'success' ? 'completion' : 'state-transition';

      events.push({
        occurred_at: (run.updated_at as string) ?? now,
        event_type: eventType,
        severity,
        summary: `Run ${id} outcome changed: ${String(prev.outcome ?? 'none')} -> ${String(run.outcome)}`,
        links: buildRunLinks(run),
      });
    }

    // Check for phase change
    if (run.phase && run.phase !== prev.phase) {
      events.push({
        occurred_at: (run.updated_at as string) ?? now,
        event_type: 'state-transition',
        severity: 'info',
        summary: `Run ${id} phase changed: ${String(prev.phase ?? 'none')} -> ${String(run.phase)}`,
        links: buildRunLinks(run),
      });
    }
  }

  return events;
}

function detectMerges(
  currentLog: string[],
  previousLog: string[],
  now: string,
): ActivityEventInsert[] {
  const events: ActivityEventInsert[] = [];
  const prevSet = new Set(previousLog);

  for (const line of currentLog) {
    if (prevSet.has(line)) continue;

    // Detect merge commits (common patterns: "Merge pull request", "Merge branch")
    const isMerge = /merge/i.test(line);
    if (!isMerge) continue;

    const prMatch = line.match(/#(\d+)/);
    const links: { label: string; url: string }[] = [];
    if (prMatch) {
      links.push({ label: `PR #${prMatch[1]}`, url: `#${prMatch[1]}` });
    }

    events.push({
      occurred_at: now,
      event_type: 'merge',
      severity: 'info',
      summary: `Merge detected: ${line}`,
      links,
    });
  }

  return events;
}

function detectErrors(
  currentRuns: Record<string, unknown>[],
  now: string,
  skipRunIds?: Set<string>,
): ActivityEventInsert[] {
  const events: ActivityEventInsert[] = [];

  for (const run of currentRuns) {
    if (run.outcome !== 'stuck') continue;
    if (skipRunIds?.has(String(run.id))) continue;

    events.push({
      occurred_at: (run.updated_at as string) ?? now,
      event_type: 'error',
      severity: 'error',
      summary: `Run ${String(run.id)} is stuck (issue #${run.issue_number ?? 'unknown'})`,
      links: buildRunLinks(run),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRunLinks(run: Record<string, unknown>): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];

  if (run.issue_url) {
    links.push({ label: `Issue #${run.issue_number ?? '?'}`, url: String(run.issue_url) });
  }
  if (run.pr_url) {
    links.push({ label: 'Pull Request', url: String(run.pr_url) });
  }

  return links;
}
