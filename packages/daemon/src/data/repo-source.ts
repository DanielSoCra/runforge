import type { SupabaseClient } from '@supabase/supabase-js';
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

export class SupabaseRepoDataSource implements RepoDataSource {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly credentials?: Pick<
      CredentialStore,
      'readConnectionCredential'
    >,
  ) {}

  async listEnabledRepos(): Promise<Result<DataRepoRecord[]>> {
    const { data, error } = await this.supabase
      .from('repos')
      .select('id, owner, name, poll_interval_ms, connection_id')
      .eq('enabled', true)
      .is('deleted_at', null);
    if (error) return err(new Error(error.message));
    return ok((data ?? []) as DataRepoRecord[]);
  }

  async upsertRepo(owner: string, name: string): Promise<Result<string>> {
    const { data, error } = await this.supabase
      .from('repos')
      .upsert({ owner, name, enabled: true } as never, {
        onConflict: 'owner,name',
      })
      .select('id')
      .single();
    if (error) return err(new Error(error.message));
    const row = data as { id: string } | null | undefined;
    if (row === null || row === undefined) {
      return err(new Error('upsertRepo returned null data'));
    }
    return ok(row.id);
  }

  async resolveConnectionToken(
    repoId: string,
    connectionId: string,
  ): Promise<string | undefined> {
    if (!this.credentials) {
      const message = 'app-owned credential store is not configured';
      console.warn(
        `[repo-manager] ${message} for connection ${connectionId}`,
      );
      await this.markCredentialStatus(repoId, 'error', message);
      return undefined;
    }

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
    const { error } = await this.supabase
      .from('repos')
      .update({
        credential_status: status,
        credential_error: message,
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', repoId);
    if (error) {
      console.warn(
        `[repo-manager] failed to update credential status for repo ${repoId}: ${error.message}`,
      );
    }
  }
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
