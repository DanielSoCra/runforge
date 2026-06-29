// src/control-plane/state.ts
import { readdir, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { writeJsonSafe, readJsonSafe } from '../lib/json-store.js';
import { ok, err, type Result } from '../lib/result.js';
import type { RunState, DaemonState } from '../types.js';
import { isComplete } from './fsm.js';

export class StateManager {
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.stateDir, 'runs'), { recursive: true });
    await this.cleanupTmpFiles();
  }

  async saveRunState(run: RunState): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await writeJsonSafe(this.runStatePath(run.issueNumber), run);
  }

  async loadRunState(issueNumber: number): Promise<Result<RunState>> {
    return readJsonSafe<RunState>(this.runStatePath(issueNumber));
  }

  async saveDaemonState(state: DaemonState): Promise<void> {
    await writeJsonSafe(join(this.stateDir, 'daemon.json'), state);
  }

  async loadDaemonState(): Promise<Result<DaemonState>> {
    return readJsonSafe<DaemonState>(join(this.stateDir, 'daemon.json'));
  }

  async findIncompleteRuns(): Promise<RunState[]> {
    const runsDir = join(this.stateDir, 'runs');
    try {
      const files = await readdir(runsDir);
      const runs: RunState[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const result = await readJsonSafe<RunState>(join(runsDir, file));
        if (result.ok && !isRunComplete(result.value) && !isRunParked(result.value)) {
          runs.push(result.value);
        }
      }
      return runs;
    } catch (e) {
      console.warn('[state] failed to scan incomplete runs:', e);
      return [];
    }
  }

  async findParkedRuns(): Promise<RunState[]> {
    const runsDir = join(this.stateDir, 'runs');
    try {
      const files = await readdir(runsDir);
      const runs: RunState[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const result = await readJsonSafe<RunState>(join(runsDir, file));
        if (result.ok && isRunParked(result.value)) {
          runs.push(result.value);
        }
      }
      return runs;
    } catch {
      return [];
    }
  }

  /**
   * Like {@link findParkedRuns} but FAIL-CLOSED: it PROPAGATES scan/read/parse
   * failures instead of swallowing them into `[]`. A caller that must
   * distinguish "genuinely no parked run" from "could not read the run store"
   * injects THIS — e.g. the operator-retry decision-park admission check, which
   * fail-closes to 503 on an unreadable store rather than risk re-admitting a
   * decision-owned issue it simply could not see. `[]` still means "no parked
   * run → proceed"; only an ERROR throws. A benign TOCTOU (a run file deleted
   * mid-scan → ENOENT) is skipped, since that candidate no longer exists.
   */
  async findParkedRunsStrict(): Promise<RunState[]> {
    const runsDir = join(this.stateDir, 'runs');
    const files = await readdir(runsDir);
    const runs: RunState[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const result = await readJsonSafe<RunState>(join(runsDir, file));
      if (!result.ok) {
        if (isMissingFileError(result.error)) continue; // TOCTOU delete — benign
        throw new Error(
          `failed to read parked-run candidate ${file}: ${result.error.message}`,
        );
      }
      if (isRunParked(result.value)) {
        runs.push(result.value);
      }
    }
    return runs;
  }

  async deleteRunState(issueNumber: number): Promise<void> {
    try {
      await unlink(this.runStatePath(issueNumber));
    } catch {
      // ignore if file doesn't exist
    }
  }

  private runStatePath(issueNumber: number): string {
    return join(this.stateDir, 'runs', `${issueNumber}.json`);
  }

  private async cleanupTmpFiles(): Promise<void> {
    try {
      const files = await readdir(this.stateDir);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          await unlink(join(this.stateDir, file)).catch(() => {});
        }
      }
      const runsDir = join(this.stateDir, 'runs');
      const runFiles = await readdir(runsDir).catch(() => [] as string[]);
      for (const file of runFiles) {
        if (file.endsWith('.tmp')) {
          await unlink(join(runsDir, file)).catch(() => {});
        }
      }
    } catch {
      // state dir may not exist yet
    }
  }
}

function isRunComplete(run: RunState): boolean {
  if (run.phase === 'stuck') return true;
  if (run.phaseCompletions[run.phase] === true) {
    return isComplete(run.phase, 'success');
  }
  return false;
}

function isRunParked(run: RunState): boolean {
  return run.phase === 'paused' && run.pausedAtPhase !== undefined;
}

/** A missing file (ENOENT) — a benign TOCTOU during a strict run-store scan. */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
