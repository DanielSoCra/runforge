import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { readDatabaseUrl } from '../../../db/src/env';
import {
  githubConnections,
  githubOrgs,
  globalSettings,
  type GlobalSettings,
} from '../../../db/src/schema';

type StoreUnavailable = {
  ok: false;
  error: 'unavailable';
  message: string;
};
type StoreNotFound = { ok: false; error: 'not-found'; message: string };
type StoreOk<T = void> = { ok: true; value: T };
type StoreResult<T = void> = StoreOk<T> | StoreUnavailable | StoreNotFound;

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

interface DashboardGitHubConnectionAccess {
  listConnections(): Promise<StoreResult<DashboardGitHubConnection[]>>;
  listOwnerOptions(): Promise<StoreResult<string[]>>;
  listOrganizations(
    connectionId: string,
  ): Promise<StoreResult<DashboardGitHubOrg[]>>;
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
}

function createDashboardDbClient() {
  const sql = postgres(readDatabaseUrl(), { max: 14 });
  const db = drizzle(sql, {
    schema: { githubConnections, githubOrgs, globalSettings },
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
