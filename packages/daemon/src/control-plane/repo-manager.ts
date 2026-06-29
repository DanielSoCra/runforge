import { Octokit } from '@octokit/rest';
import { createWorkDetector, type WorkDetector } from './work-detection.js';
import { ok, type Result } from '../lib/result.js';
import { createPhaseLabelMirror } from './phase-labels.js';
import type { DataRepoRecord, RepoDataSource } from '../data/repo-source.js';

export type RepoRecord = DataRepoRecord;

interface PollEntry {
  detector: WorkDetector;
  intervalHandle: ReturnType<typeof setInterval>;
  activeRuns: number;
  pollInProgress: boolean;
  // Epoch-ms when the in-flight poll started, or null when idle (B5 tick-stall
  // detection, first-use safety net). Set when pollInProgress flips true, cleared
  // when it flips false. The watchdog reads it via pollerSnapshot() to detect a
  // poll that started but never settled (a hung orchestration await).
  pollStartedAt: number | null;
  pendingDisable: boolean;
  owner: string;
  name: string;
  connectionId: string | null;
}

/** Read-only per-repo poller liveness snapshot (B5 watchdog input). */
export interface PollerSnapshot {
  repoId: string;
  owner: string;
  name: string;
  pollInProgress: boolean;
  pollStartedAt: number | null;
}

export class RepoManager {
  private pollers = new Map<string, PollEntry>();
  private fallbackHandle: ReturnType<typeof setInterval> | null = null;
  private readonly source: RepoDataSource;

  constructor(
    source: RepoDataSource,
    private readonly defaultPollIntervalMs: number,
    private readonly onPoll: (
      repoId: string,
      owner: string,
      name: string,
      detector: WorkDetector,
    ) => void | Promise<void>,
    // Injectable clock (epoch-ms) so the B5 watchdog tick-stall window is
    // deterministic under fake timers. Defaults to wall-clock in production.
    private readonly now: () => number = () => Date.now(),
  ) {
    this.source = source;
  }

  /**
   * Read-only liveness snapshot of every poller (B5 watchdog input). Returns the
   * per-repo `pollInProgress` flag plus `pollStartedAt` (epoch-ms or null) so the
   * watchdog can detect a poll that started but never settled past idle-timeout.
   */
  pollerSnapshot(): PollerSnapshot[] {
    const out: PollerSnapshot[] = [];
    for (const [repoId, entry] of this.pollers) {
      out.push({
        repoId,
        owner: entry.owner,
        name: entry.name,
        pollInProgress: entry.pollInProgress,
        pollStartedAt: entry.pollStartedAt,
      });
    }
    return out;
  }

  async initialize(): Promise<Result<void>> {
    const result = await this.loadEnabledRepos();
    if (!result.ok) return result;
    for (const repo of result.value) {
      await this.startPoller(repo);
    }
    this.fallbackHandle = setInterval(() => {
      void this.sync();
    }, 60_000);
    return ok(undefined);
  }

  async reload(): Promise<{ active: number }> {
    await this.sync();
    return { active: this.activePollerCount() };
  }

  async scanNow(): Promise<{ scanned: number }> {
    let scanned = 0;
    for (const [repoId, entry] of this.pollers) {
      if (entry.pendingDisable) continue;
      if (this.startPoll(repoId, entry)) scanned++;
    }
    return { scanned };
  }

  async upsertRepo(owner: string, name: string): Promise<Result<string>> {
    return this.source.upsertRepo(owner, name);
  }

  notifyRunStart(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (entry) entry.activeRuns++;
  }

  notifyRunEnd(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (!entry) return;
    entry.activeRuns = Math.max(0, entry.activeRuns - 1);
    if (entry.pendingDisable && entry.activeRuns === 0) {
      this.removePoller(repoId);
    }
  }

  disablePoller(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (!entry) return;
    clearInterval(entry.intervalHandle);
    entry.pendingDisable = true;
    if (entry.activeRuns === 0) {
      this.removePoller(repoId);
    }
  }

  getRepoId(owner: string, name: string): string | undefined {
    for (const [id, entry] of this.pollers) {
      if (entry.owner === owner && entry.name === name) return id;
    }
    return undefined;
  }

  activePollerCount(): number {
    return this.pollers.size;
  }

  stop(): void {
    if (this.fallbackHandle) {
      clearInterval(this.fallbackHandle);
      this.fallbackHandle = null;
    }
    for (const [id] of this.pollers) this.removePoller(id);
  }

  private async sync(): Promise<void> {
    const result = await this.loadEnabledRepos();
    if (!result.ok) return;

    const enabledIds = new Set(result.value.map((r) => r.id));

    // Start pollers for new repos
    for (const repo of result.value) {
      if (!this.pollers.has(repo.id)) await this.startPoller(repo);
    }

    // Disable pollers for repos no longer enabled
    for (const [id] of this.pollers) {
      if (!enabledIds.has(id)) this.disablePoller(id);
    }
  }

  private async loadEnabledRepos(): Promise<Result<RepoRecord[]>> {
    return this.source.listEnabledRepos();
  }

  private async resolveToken(
    repoId: string,
    connectionId: string | null,
  ): Promise<string | undefined> {
    if (!connectionId) return process.env.GITHUB_TOKEN;
    return this.source.resolveConnectionToken(repoId, connectionId);
  }

  private async startPoller(repo: RepoRecord): Promise<void> {
    const token = await this.resolveToken(repo.id, repo.connection_id);
    if (repo.connection_id && !token) return;
    const octokit = new Octokit({ auth: token });
    void createPhaseLabelMirror(
      octokit,
      repo.owner,
      repo.name,
    ).provisionLabels();
    const detector = createWorkDetector(octokit, repo.owner, repo.name);
    const intervalMs = repo.poll_interval_ms ?? this.defaultPollIntervalMs;

    const intervalHandle = setInterval(() => {
      const entry = this.pollers.get(repo.id);
      if (entry) this.startPoll(repo.id, entry);
    }, intervalMs);

    this.pollers.set(repo.id, {
      detector,
      intervalHandle,
      activeRuns: 0,
      pollInProgress: false,
      pollStartedAt: null,
      pendingDisable: false,
      owner: repo.owner,
      name: repo.name,
      connectionId: repo.connection_id,
    });
  }

  private startPoll(repoId: string, entry: PollEntry): boolean {
    if (entry.pendingDisable || entry.pollInProgress) return false;
    entry.pollInProgress = true;
    entry.pollStartedAt = this.now();
    Promise.resolve()
      .then(() => this.onPoll(repoId, entry.owner, entry.name, entry.detector))
      .catch((e) =>
        console.error(
          `[repo-manager] Poll failed for ${entry.owner}/${entry.name}:`,
          e,
        ),
      )
      .finally(() => {
        const latest = this.pollers.get(repoId);
        if (latest) {
          latest.pollInProgress = false;
          latest.pollStartedAt = null;
        }
      });
    return true;
  }

  private removePoller(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (entry) {
      clearInterval(entry.intervalHandle);
    }
    this.pollers.delete(repoId);
  }

  async resolveTokenForRepo(repoId: string): Promise<string | undefined> {
    const entry = this.pollers.get(repoId);
    if (!entry) return process.env.GITHUB_TOKEN;
    return this.resolveToken(repoId, entry.connectionId);
  }
}
