import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { readDatabaseUrl } from '../../../db/src/env';
import {
  githubConnections,
  githubOrgs,
  globalSettings,
  repos,
  type GlobalSettings,
} from '../../../db/src/schema';

type StoreUnavailable = {
  ok: false;
  error: 'unavailable';
  message: string;
};
type StoreNotFound = { ok: false; error: 'not-found'; message: string };
type StoreConflict = { ok: false; error: 'conflict'; message: string };
type StoreOk<T = void> = { ok: true; value: T };
type StoreResult<T = void> =
  | StoreOk<T>
  | StoreUnavailable
  | StoreNotFound
  | StoreConflict;

interface DashboardSettingsAccess {
  readGlobalSettings(): Promise<StoreResult<GlobalSettings>>;
  updateGlobalSettings(
    changes: Partial<GlobalSettings>,
  ): Promise<StoreResult<GlobalSettings>>;
}

export interface DashboardGitHubConnection {
  id: string;
  displayName: string;
  githubLogin: string;
  avatarUrl: string | null;
  status: string;
  createdAt: Date;
  organizations: Array<{ login: string }>;
}

export interface DashboardGitHubOrg {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isSelected: boolean;
}

export interface DashboardRepositoryImport {
  owner: string;
  name: string;
}

interface DashboardGitHubConnectionAccess {
  listConnections(): Promise<StoreResult<DashboardGitHubConnection[]>>;
  listOwnerOptions(): Promise<StoreResult<string[]>>;
  listOrganizations(
    connectionId: string,
  ): Promise<StoreResult<DashboardGitHubOrg[]>>;
  removeConnection(
    connectionId: string,
  ): Promise<StoreResult<{ disableError?: string }>>;
  importRepositories(
    connectionId: string,
    repositories: DashboardRepositoryImport[],
  ): Promise<StoreResult>;
  removeRepository(repoId: string, connectionId: string): Promise<StoreResult>;
}

export interface DashboardStores {
  settings: DashboardSettingsAccess;
  githubConnections: DashboardGitHubConnectionAccess;
}

type DashboardDb = ReturnType<typeof createDashboardDbClient>['db'];

let dashboardStores: DashboardStores | undefined;

export function getDashboardStores(): DashboardStores {
  if (!dashboardStores) {
    const db = getDashboardDbClient().db;
    dashboardStores = {
      settings: new DashboardSettingsStore(db),
      githubConnections: new DashboardGitHubConnectionStore(db),
    };
  }
  return dashboardStores;
}

class DashboardSettingsStore implements DashboardSettingsAccess {
  constructor(private readonly db: DashboardDb) {}

  async readGlobalSettings() {
    return unavailableOnThrow(async () => {
      const [row] = await this.db.select().from(globalSettings).limit(1);
      return row ? ok(row) : notFound('global settings were not found');
    });
  }

  async updateGlobalSettings(changes: Partial<GlobalSettings>) {
    return unavailableOnThrow(async () => {
      const [existing] = await this.db
        .select({ id: globalSettings.id })
        .from(globalSettings)
        .limit(1);
      if (!existing) return notFound('global settings were not found');

      const updatable = withoutUndefined({
        concurrencyLimit: changes.concurrencyLimit,
        dailyBudgetLimit: changes.dailyBudgetLimit,
        defaultModel: changes.defaultModel,
      });
      const [row] = await this.db
        .update(globalSettings)
        .set({ ...updatable, updatedAt: new Date() })
        .where(eq(globalSettings.id, existing.id))
        .returning();
      return row
        ? ok(row)
        : unavailable('global settings update returned no row');
    });
  }
}

class DashboardGitHubConnectionStore
  implements DashboardGitHubConnectionAccess
{
  constructor(private readonly db: DashboardDb) {}

  async listConnections() {
    return unavailableOnThrow(async () => {
      const connections = await this.db
        .select({
          id: githubConnections.id,
          displayName: githubConnections.displayName,
          githubLogin: githubConnections.githubLogin,
          avatarUrl: githubConnections.avatarUrl,
          status: githubConnections.status,
          createdAt: githubConnections.createdAt,
        })
        .from(githubConnections)
        .orderBy(githubConnections.createdAt);

      if (connections.length === 0) return ok([]);

      const orgs = await this.db
        .select({
          connectionId: githubOrgs.connectionId,
          login: githubOrgs.login,
        })
        .from(githubOrgs)
        .where(
          inArray(
            githubOrgs.connectionId,
            connections.map((connection) => connection.id),
          ),
        )
        .orderBy(githubOrgs.login);

      const orgsByConnection = new Map<string, Array<{ login: string }>>();
      for (const org of orgs) {
        const entries = orgsByConnection.get(org.connectionId) ?? [];
        entries.push({ login: org.login });
        orgsByConnection.set(org.connectionId, entries);
      }

      return ok(
        connections.map((connection) => ({
          ...connection,
          organizations: orgsByConnection.get(connection.id) ?? [],
        })),
      );
    });
  }

  async listOwnerOptions() {
    return unavailableOnThrow(async () => {
      const [connections, orgs] = await Promise.all([
        this.db
          .select({ login: githubConnections.githubLogin })
          .from(githubConnections)
          .where(eq(githubConnections.status, 'active')),
        this.db.select({ login: githubOrgs.login }).from(githubOrgs),
      ]);

      return ok(
        Array.from(
          new Set([
            ...connections.map((connection) => connection.login),
            ...orgs.map((org) => org.login),
          ]),
        ).sort(),
      );
    });
  }

  async listOrganizations(connectionId: string) {
    return unavailableOnThrow(async () => {
      const orgs = await this.db
        .select({
          id: githubOrgs.id,
          login: githubOrgs.login,
          name: githubOrgs.name,
          avatarUrl: githubOrgs.avatarUrl,
          isSelected: githubOrgs.isSelected,
        })
        .from(githubOrgs)
        .where(eq(githubOrgs.connectionId, connectionId))
        .orderBy(githubOrgs.login);

      return ok(orgs);
    });
  }

  async removeConnection(connectionId: string) {
    return unavailableOnThrow(async () => {
      const linkedRepos = await this.db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.connectionId, connectionId));

      await this.db
        .delete(githubConnections)
        .where(eq(githubConnections.id, connectionId));

      let disableError: string | undefined;
      if (linkedRepos.length > 0) {
        try {
          await this.db
            .update(repos)
            .set({ enabled: false, updatedAt: new Date() })
            .where(
              inArray(
                repos.id,
                linkedRepos.map((repo) => repo.id),
              ),
            );
        } catch (error) {
          disableError = errorMessage(error);
        }
      }

      return ok({ disableError });
    });
  }

  async importRepositories(
    connectionId: string,
    repositories: DashboardRepositoryImport[],
  ) {
    return unavailableOnThrow(async () => {
      for (const repository of repositories) {
        await this.db
          .insert(repos)
          .values({
            owner: repository.owner,
            name: repository.name,
            connectionId,
            deletedAt: null,
            enabled: false,
          })
          .onConflictDoNothing({ target: [repos.owner, repos.name] });

        await this.db
          .update(repos)
          .set({
            connectionId,
            deletedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(repos.owner, repository.owner),
              eq(repos.name, repository.name),
            ),
          );
      }

      return ok(undefined);
    });
  }

  async removeRepository(repoId: string, connectionId: string) {
    return unavailableOnThrow(async () => {
      const [repo] = await this.db
        .select({ enabled: repos.enabled })
        .from(repos)
        .where(and(eq(repos.id, repoId), eq(repos.connectionId, connectionId)))
        .limit(1);
      if (!repo) return notFound('repository was not found');
      if (repo.enabled) {
        return conflict('enabled repositories must be disabled before removal');
      }

      await this.db
        .update(repos)
        .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
        .where(and(eq(repos.id, repoId), eq(repos.connectionId, connectionId)));

      return ok(undefined);
    });
  }
}

function createDashboardDbClient() {
  const sql = postgres(readDatabaseUrl(), { max: 14 });
  const db = drizzle(sql, {
    schema: { githubConnections, githubOrgs, globalSettings, repos },
  });
  return { db, sql };
}

let dashboardDbClient: ReturnType<typeof createDashboardDbClient> | undefined;

function getDashboardDbClient() {
  dashboardDbClient ??= createDashboardDbClient();
  return dashboardDbClient;
}

async function unavailableOnThrow<T>(
  operation: () => Promise<StoreResult<T>>,
): Promise<StoreResult<T>> {
  try {
    return await operation();
  } catch (error) {
    return unavailable(errorMessage(error));
  }
}

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function notFound(message: string): StoreResult<never> {
  return { ok: false, error: 'not-found', message };
}

function conflict(message: string): StoreResult<never> {
  return { ok: false, error: 'conflict', message };
}

function unavailable(message: string): StoreResult<never> {
  return { ok: false, error: 'unavailable', message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
