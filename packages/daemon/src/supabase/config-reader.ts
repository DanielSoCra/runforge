// Retired compatibility shim. Use PostgresConfigReader from ../data/config-reader.js.

import type { GlobalConfig, RepoConfig } from '../config.js';

const DEFAULT_GLOBAL: GlobalConfig = {
  concurrencyLimit: 1,
  dailyBudgetLimit: null,
  defaultModel: 'claude-sonnet-4-6',
};

export class SupabaseConfigReader {
  constructor(_client?: unknown) {}

  async start(): Promise<void> {
    throw new Error(
      'SupabaseConfigReader has been retired; use DAEMON_DATA_BACKEND=postgres',
    );
  }

  stop(): void {
    // No-op retained for older imports while traceability catches up.
  }

  getGlobalConfig(): GlobalConfig {
    return DEFAULT_GLOBAL;
  }

  getRepoConfig(_owner: string, _name: string): RepoConfig | undefined {
    return undefined;
  }
}
