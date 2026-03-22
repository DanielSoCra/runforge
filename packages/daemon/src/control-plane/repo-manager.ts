import { createClient } from '@supabase/supabase-js';
import { Octokit } from '@octokit/rest';
import { createWorkDetector, type WorkDetector } from './work-detection.js';
import { ok, err, type Result } from '../lib/result.js';

export interface RepoRecord {
  id: string;
  owner: string;
  name: string;
  poll_interval_ms: number | null;
  connection_id: string | null;
}

interface PollEntry {
  detector: WorkDetector;
  intervalHandle: ReturnType<typeof setInterval>;
  activeRuns: number;
  pendingDisable: boolean;
  owner: string;
  name: string;
}

type SupabaseClient = ReturnType<typeof createClient>;

export class RepoManager {
  private pollers = new Map<string, PollEntry>();
  private fallbackHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly defaultPollIntervalMs: number,
    private readonly onPoll: (repoId: string, owner: string, name: string, detector: WorkDetector) => void,
  ) {}

  async initialize(): Promise<Result<void>> {
    const result = await this.loadEnabledRepos();
    if (!result.ok) return result;
    for (const repo of result.value) {
      await this.startPoller(repo);
    }
    this.fallbackHandle = setInterval(() => { void this.sync(); }, 60_000);
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
      this.onPoll(repoId, entry.owner, entry.name, entry.detector);
      scanned++;
    }
    return { scanned };
  }

  async upsertRepo(owner: string, name: string): Promise<Result<string>> {
    const { data, error } = await this.supabase
      .from('repos')
      .upsert({ owner, name, enabled: true }, { onConflict: 'owner,name' })
      .select('id')
      .single();
    if (error) return err(new Error(error.message));
    if (!data) return err(new Error('upsertRepo returned null data'));
    return ok((data as { id: string }).id);
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
    if (this.fallbackHandle) { clearInterval(this.fallbackHandle); this.fallbackHandle = null; }
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
    const { data, error } = await this.supabase
      .from('repos')
      .select('id, owner, name, poll_interval_ms, connection_id')
      .eq('enabled', true)
      .is('deleted_at', null);
    if (error) return err(new Error(error.message));
    return ok((data ?? []) as RepoRecord[]);
  }

  private async resolveToken(connectionId: string | null): Promise<string | undefined> {
    if (!connectionId) return process.env.GITHUB_TOKEN;
    const { data } = await this.supabase.rpc('decrypt_github_token', {
      p_connection_id: connectionId,
    });
    return (data as string | null) ?? process.env.GITHUB_TOKEN;
  }

  private async startPoller(repo: RepoRecord): Promise<void> {
    const token = await this.resolveToken(repo.connection_id);
    const octokit = new Octokit({ auth: token });
    const detector = createWorkDetector(octokit, repo.owner, repo.name);
    const intervalMs = repo.poll_interval_ms ?? this.defaultPollIntervalMs;

    const intervalHandle = setInterval(() => {
      const entry = this.pollers.get(repo.id);
      if (entry && !entry.pendingDisable) {
        this.onPoll(repo.id, repo.owner, repo.name, detector);
      }
    }, intervalMs);

    this.pollers.set(repo.id, {
      detector,
      intervalHandle,
      activeRuns: 0,
      pendingDisable: false,
      owner: repo.owner,
      name: repo.name,
    });
  }

  private removePoller(repoId: string): void {
    const entry = this.pollers.get(repoId);
    if (entry) { clearInterval(entry.intervalHandle); }
    this.pollers.delete(repoId);
  }
}
