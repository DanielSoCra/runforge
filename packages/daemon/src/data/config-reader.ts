import type {
  PluginStore,
  RepoStore,
  Repository,
  SettingsAccess,
  StoreResult,
} from '@runforge/db';

import type { GlobalConfig, RepoConfig } from '../config.js';
import { err, ok, type Result } from '../lib/result.js';

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

const DEFAULT_GLOBAL: GlobalConfig = {
  concurrencyLimit: 1,
  dailyBudgetLimit: null,
  defaultModel: 'claude-sonnet-4-6',
};

export interface ConfigFetchError {
  category: 'unreachable' | 'rejected';
  cause: { class: string; code: string | null; message: string };
}

export interface ConfigReader {
  start(): Promise<void>;
  stop(): void;
  getGlobalConfig(): GlobalConfig;
  getRepoConfig(owner: string, name: string): RepoConfig | undefined;
  tryFetch(): Promise<Result<void, ConfigFetchError>>;
  isStartupDegraded(): boolean;
  getLastConfigError(): ConfigFetchError | null;
}

export class PostgresConfigReader implements ConfigReader {
  private globalConfig: GlobalConfig = DEFAULT_GLOBAL;
  private repoConfigs: Map<string, RepoConfig> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupDegraded = true;
  private lastConfigError: ConfigFetchError | null = null;

  constructor(
    private readonly settings: SettingsAccess,
    private readonly repos: RepoStore,
    private readonly plugins: PluginStore,
  ) {}

  start(): Promise<void> {
    const raw = Number(process.env.DAEMON_SYNC_INTERVAL_MS);
    const intervalMs =
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.fetchSafe();
    }, intervalMs);
    return Promise.resolve();
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

  isStartupDegraded(): boolean {
    return this.startupDegraded;
  }

  getLastConfigError(): ConfigFetchError | null {
    return this.lastConfigError;
  }

  /**
   * Load config without throwing. On success, assigns the new config and
   * clears the degraded flag (one-way: it is set `false` exactly once and is
   * never flipped back to `true` — runtime DB-outage resilience is out of
   * scope, the steady-state timer keeps last-known-good). On failure, returns
   * a structured `ConfigFetchError` describing category + driver cause.
   */
  async tryFetch(): Promise<Result<void, ConfigFetchError>> {
    const settings = await this.settings.readGlobalSettings();
    let newGlobal: GlobalConfig;
    if (!settings.ok && settings.error === 'not-found') {
      newGlobal = DEFAULT_GLOBAL;
    } else {
      const mapped = mapStore(settings);
      if (!mapped.ok) return this.fail(mapped.error);
      newGlobal = toGlobalConfig(mapped.value);
    }

    const reposResult = mapStore(await this.repos.listEnabledRepositories());
    if (!reposResult.ok) return this.fail(reposResult.error);
    const repoRows = reposResult.value;

    const pluginEntries = await Promise.all(
      repoRows.map(
        async (repo) =>
          [repo, await this.plugins.listActivePlugins(repo.id)] as const,
      ),
    );

    const newConfigs = new Map<string, RepoConfig>();
    for (const [repo, pluginResult] of pluginEntries) {
      const mapped = mapStore(pluginResult);
      if (!mapped.ok) return this.fail(mapped.error);
      const activePlugins = mapped.value.map((plugin) => ({
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
    this.startupDegraded = false;
    this.lastConfigError = null;
    return ok(undefined);
  }

  private fail(error: ConfigFetchError): Result<void, ConfigFetchError> {
    this.lastConfigError = error;
    return err(error);
  }

  private async fetch(): Promise<void> {
    const result = await this.tryFetch();
    if (!result.ok) {
      throw new Error(
        `[config-reader] config fetch failed (${result.error.category}, ${result.error.cause.code ?? 'no-code'}): ${result.error.cause.message}`,
      );
    }
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

/**
 * Map a `StoreResult` to a local `Result` carrying a structured
 * `ConfigFetchError` on failure. `unavailable` propagates its category + cause;
 * `denied` is always `rejected`; `not-found` is treated as `rejected` (the
 * caller handles the legitimate global-settings not-found case before calling
 * this).
 */
function mapStore<T>(result: StoreResult<T>): Result<T, ConfigFetchError> {
  if (result.ok) return ok(result.value);
  if (result.error === 'unavailable') {
    return err({ category: result.category, cause: result.cause });
  }
  if (result.error === 'denied') {
    return err({
      category: 'rejected',
      cause: { class: 'StoreDenied', code: null, message: result.message },
    });
  }
  return err({
    category: 'rejected',
    cause: { class: 'StoreNotFound', code: null, message: result.message },
  });
}
