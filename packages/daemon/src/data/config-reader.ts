import type {
  PluginStore,
  RepoStore,
  Repository,
  SettingsAccess,
  StoreResult,
} from '@auto-claude/db';

import type { GlobalConfig, RepoConfig } from '../config.js';

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

const DEFAULT_GLOBAL: GlobalConfig = {
  concurrencyLimit: 1,
  dailyBudgetLimit: null,
  defaultModel: 'claude-sonnet-4-6',
};

export class PostgresConfigReader {
  private globalConfig: GlobalConfig = DEFAULT_GLOBAL;
  private repoConfigs: Map<string, RepoConfig> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly settings: SettingsAccess,
    private readonly repos: RepoStore,
    private readonly plugins: PluginStore,
  ) {}

  async start(): Promise<void> {
    await this.fetch();
    const raw = Number(process.env.DAEMON_SYNC_INTERVAL_MS);
    const intervalMs =
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.fetchSafe();
    }, intervalMs);
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
    const settings = await this.settings.readGlobalSettings();
    const newGlobal =
      !settings.ok && settings.error === 'not-found'
        ? DEFAULT_GLOBAL
        : toGlobalConfig(requireStore(settings, 'global settings fetch'));

    const repoRows = requireStore(
      await this.repos.listEnabledRepositories(),
      'enabled repos fetch',
    );
    const pluginEntries = await Promise.all(
      repoRows.map(
        async (repo) =>
          [repo, await this.plugins.listActivePlugins(repo.id)] as const,
      ),
    );

    const newConfigs = new Map<string, RepoConfig>();
    for (const [repo, pluginResult] of pluginEntries) {
      const activePlugins = requireStore(
        pluginResult,
        `active plugins fetch for ${repo.owner}/${repo.name}`,
      ).map((plugin) => ({
        id: plugin.pluginId,
        activatedAt: plugin.activatedAt?.toISOString() ?? '',
      }));
      newConfigs.set(
        `${repo.owner}/${repo.name}`,
        toRepoConfig(repo, activePlugins),
      );
    }

    this.globalConfig = newGlobal;
    this.repoConfigs = newConfigs;
  }

  private async fetchSafe(): Promise<void> {
    try {
      await this.fetch();
    } catch (error) {
      console.warn(
        '[config-reader] Poll failed, keeping cached config:',
        (error as Error).message,
      );
    }
  }
}

function toGlobalConfig(settings: {
  concurrencyLimit: number;
  dailyBudgetLimit: number | null;
  defaultModel: string;
}): GlobalConfig {
  return {
    concurrencyLimit: settings.concurrencyLimit,
    dailyBudgetLimit: settings.dailyBudgetLimit ?? null,
    defaultModel: settings.defaultModel,
  };
}

function toRepoConfig(
  repo: Repository,
  activePlugins: RepoConfig['activePlugins'],
): RepoConfig {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    budgetLimit: repo.budgetLimit ?? null,
    concurrencyLimit: repo.concurrencyLimit,
    activePlugins,
  };
}

function requireStore<T>(result: StoreResult<T>, action: string): T {
  if (result.ok) return result.value;
  throw new Error(`[config-reader] ${action} failed: ${result.message}`);
}
