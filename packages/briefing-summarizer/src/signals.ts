/**
 * Signal collection module.
 *
 * Collects four signal sources in parallel: runs table, daemon status,
 * git log, and heartbeat. Partial failure produces a degraded result
 * with gap notes rather than a total failure.
 */

import { execSync } from 'node:child_process';
import { log } from './log.js';

export interface DaemonStatus {
  state: string;
  uptime?: number;
  activeRuns?: number;
  [key: string]: unknown;
}

export interface SignalResult {
  runs: Record<string, unknown>[];
  daemonStatus: DaemonStatus | null;
  gitLog: string[];
  heartbeatAt: string | null;
  gaps: string[];
}

export interface RunSignalSource {
  listRunsSince(since: string): Promise<Record<string, unknown>[]>;
}

/**
 * Collect all four signal sources in parallel.
 * Each source is independently wrapped — a single failure produces
 * a gap note but does not block other sources.
 */
export async function collectSignals(
  runSource: RunSignalSource,
  daemonUrl: string,
  since: string,
): Promise<SignalResult> {
  const gaps: string[] = [];

  const [runsResult, daemonResult, gitResult] = await Promise.allSettled([
    runSource.listRunsSince(since),
    collectDaemonStatus(daemonUrl),
    collectGitLog(since),
  ]);

  // --- Runs ---
  let runs: Record<string, unknown>[] = [];
  if (runsResult.status === 'fulfilled') {
    runs = runsResult.value;
  } else {
    gaps.push(`runs: ${String(runsResult.reason)}`);
    log('warn', `Failed to collect runs: ${String(runsResult.reason)}`);
  }

  // --- Daemon status ---
  let daemonStatus: DaemonStatus | null = null;
  if (daemonResult.status === 'fulfilled') {
    daemonStatus = daemonResult.value;
  } else {
    gaps.push(`daemon: ${String(daemonResult.reason)}`);
    log(
      'warn',
      `Failed to collect daemon status: ${String(daemonResult.reason)}`,
    );
  }

  // --- Git log ---
  let gitLog: string[] = [];
  if (gitResult.status === 'fulfilled') {
    gitLog = gitResult.value;
  } else {
    gaps.push(`git: ${String(gitResult.reason)}`);
    log('warn', `Failed to collect git log: ${String(gitResult.reason)}`);
  }

  // --- Heartbeat: derived from daemon status ---
  let heartbeatAt: string | null = null;
  if (daemonStatus) {
    heartbeatAt = new Date().toISOString();
  } else if (!gaps.some((g) => g.startsWith('daemon:'))) {
    gaps.push('heartbeat: daemon unreachable');
  }

  return { runs, daemonStatus, gitLog, heartbeatAt, gaps };
}

// ---------------------------------------------------------------------------
// Individual collectors
// ---------------------------------------------------------------------------

async function collectDaemonStatus(daemonUrl: string): Promise<DaemonStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const token = process.env.RUNFORGE_CONTROL_TOKEN;
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== '') {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`${daemonUrl}/status`, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) throw new Error(`Daemon status returned ${res.status}`);
    return (await res.json()) as DaemonStatus;
  } finally {
    clearTimeout(timeout);
  }
}

async function collectGitLog(since: string): Promise<string[]> {
  try {
    const sinceDate = new Date(since).toISOString().split('T')[0];
    const cwd = process.env.GIT_REPO_PATH || process.cwd();
    const output = execSync(`git log --oneline --since="${sinceDate}"`, {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd,
    });
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    throw new Error('git log command failed — repo may not be mounted');
  }
}
