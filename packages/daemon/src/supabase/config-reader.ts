// src/supabase/config-reader.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RepoConfig, GlobalConfig } from '../config.js';

const DEFAULT_GLOBAL: GlobalConfig = {
  concurrencyLimit: 1,
  dailyBudgetLimit: null,
  defaultModel: 'claude-sonnet-4-6',
};

export class SupabaseConfigReader {
  private globalConfig: GlobalConfig = DEFAULT_GLOBAL;
  private repoConfigs: Map<string, RepoConfig> = new Map(); // key: "owner/name"
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly supabase: SupabaseClient) {}

  async start(): Promise<void> {
    await this.fetch(); // throws if Supabase is unreachable
    this.timer = setInterval(() => { void this.fetchSafe(); }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getGlobalConfig(): GlobalConfig {
    return this.globalConfig;
  }

  getRepoConfig(owner: string, name: string): RepoConfig | undefined {
    return this.repoConfigs.get(`${owner}/${name}`);
  }

  private async fetch(): Promise<void> {
    // Step 1: global_settings
    const { data: gsRows, error: gsErr } = await this.supabase
      .from('global_settings')
      .select('id, concurrency_limit, daily_budget_limit, default_model')
      .limit(1);
    if (gsErr) throw new Error(`[config-reader] global_settings fetch failed: ${gsErr.message}`);

    const gs = (gsRows ?? [])[0];
    const newGlobal: GlobalConfig = gs
      ? {
          concurrencyLimit: gs.concurrency_limit,
          dailyBudgetLimit: gs.daily_budget_limit ?? null,
          defaultModel: gs.default_model,
        }
      : DEFAULT_GLOBAL;

    // Step 2: repos
    const { data: repoRows, error: repoErr } = await this.supabase
      .from('repos')
      .select('id, owner, name, budget_limit, concurrency_limit')
      .eq('enabled', true)
      .is('deleted_at', null);
    if (repoErr) throw new Error(`[config-reader] repos fetch failed: ${repoErr.message}`);

    // Step 3: repo_plugins
    const { data: pluginRows, error: pluginErr } = await this.supabase
      .from('repo_plugins')
      .select('repo_id, plugin_id, activated_at')
      .eq('active', true);
    if (pluginErr) throw new Error(`[config-reader] repo_plugins fetch failed: ${pluginErr.message}`);

    // Build plugin map: repo_id → plugins[]
    const pluginsByRepo = new Map<string, Array<{ id: string; activatedAt: string }>>();
    for (const p of pluginRows ?? []) {
      const list = pluginsByRepo.get(p.repo_id) ?? [];
      list.push({ id: p.plugin_id, activatedAt: p.activated_at });
      pluginsByRepo.set(p.repo_id, list);
    }

    // Atomically replace cache
    const newConfigs = new Map<string, RepoConfig>();
    for (const r of repoRows ?? []) {
      newConfigs.set(`${r.owner}/${r.name}`, {
        id: r.id,
        owner: r.owner,
        name: r.name,
        budgetLimit: r.budget_limit ?? null,
        concurrencyLimit: r.concurrency_limit,
        activePlugins: pluginsByRepo.get(r.id) ?? [],
      });
    }

    this.globalConfig = newGlobal;
    this.repoConfigs = newConfigs;
  }

  private async fetchSafe(): Promise<void> {
    try {
      await this.fetch();
    } catch (e) {
      console.warn('[config-reader] Poll failed, keeping cached config:', (e as Error).message);
    }
  }
}
