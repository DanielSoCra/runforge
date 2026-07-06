import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { readDatabaseUrl } from './env.js';
import * as schema from './schema.js';

export interface DbClientOptions {
  url?: string;
  maxConnections?: number;
}

export function createDbClient(options: DbClientOptions = {}) {
  const sql = postgres(options.url ?? readDatabaseUrl(), {
    max: options.maxConnections ?? 14,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let singleton: ReturnType<typeof createDbClient> | undefined;

export function getDbClient() {
  singleton ??= createDbClient();
  return singleton;
}

export async function closeDbClient(): Promise<void> {
  if (!singleton) return;
  await singleton.sql.end();
  singleton = undefined;
}

export type RunforgeDb = ReturnType<typeof createDbClient>['db'];
