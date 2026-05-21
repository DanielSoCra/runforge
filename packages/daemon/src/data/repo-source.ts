import type { CredentialStore, RepoStore, StoreResult } from '@auto-claude/db';

import { err, ok, type Result } from '../lib/result.js';

export interface DataRepoRecord {
  id: string;
  owner: string;
  name: string;
  poll_interval_ms: number | null;
  connection_id: string | null;
}

export interface RepoDataSource {
  listEnabledRepos(): Promise<Result<DataRepoRecord[]>>;
  upsertRepo(owner: string, name: string): Promise<Result<string>>;
  resolveConnectionToken(
    repoId: string,
    connectionId: string,
  ): Promise<string | undefined>;
}

export class PostgresRepoDataSource implements RepoDataSource {
  constructor(
    private readonly repos: RepoStore,
    private readonly credentials: CredentialStore,
  ) {}

  async listEnabledRepos(): Promise<Result<DataRepoRecord[]>> {
    const result = await this.repos.listEnabledRepositories();
    if (!result.ok) return storeErr(result);
    return ok(
      result.value.map((repo) => ({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        poll_interval_ms: repo.pollIntervalMs,
        connection_id: repo.connectionId,
      })),
    );
  }

  async upsertRepo(owner: string, name: string): Promise<Result<string>> {
    const result = await this.repos.upsertRepository({
      owner,
      name,
      enabled: true,
    });
    if (!result.ok) return storeErr(result);
    return ok(result.value.id);
  }

  async resolveConnectionToken(
    repoId: string,
    connectionId: string,
  ): Promise<string | undefined> {
    const result =
      await this.credentials.readConnectionCredential(connectionId);
    if (!result.ok) {
      console.warn(
        `[repo-manager] read GitHub connection credential failed for connection ${connectionId}: ${result.message}`,
      );
      await this.markCredentialStatus(repoId, 'error', result.message);
      return undefined;
    }
    if (result.value.trim() === '') {
      const message = 'GitHub connection credential returned empty';
      console.warn(`[repo-manager] ${message} for connection ${connectionId}`);
      await this.markCredentialStatus(repoId, 'error', message);
      return undefined;
    }
    await this.markCredentialStatus(repoId, 'ok', null);
    return result.value;
  }

  private async markCredentialStatus(
    repoId: string,
    status: 'ok' | 'error',
    message: string | null,
  ): Promise<void> {
    const result = await this.repos.setCredentialStatus(
      repoId,
      status,
      message ?? undefined,
    );
    if (!result.ok) {
      console.warn(
        `[repo-manager] failed to update credential status for repo ${repoId}: ${result.message}`,
      );
    }
  }
}

function storeErr<T>(result: StoreResult<T>): Result<never> {
  return err(
    new Error(result.ok ? 'unexpected successful StoreResult' : result.message),
  );
}
