import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { readDatabaseUrl } from '../../../db/src/env';
import { globalSettings, type GlobalSettings } from '../../../db/src/schema';

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

export interface DashboardStores {
  settings: DashboardSettingsAccess;
}

type DashboardDb = ReturnType<typeof createDashboardDbClient>['db'];

let dashboardStores: DashboardStores | undefined;

export function getDashboardStores(): DashboardStores {
  dashboardStores ??= {
    settings: new DashboardSettingsStore(getDashboardDbClient().db),
  };
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

function createDashboardDbClient() {
  const sql = postgres(readDatabaseUrl(), { max: 14 });
  const db = drizzle(sql, { schema: { globalSettings } });
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
