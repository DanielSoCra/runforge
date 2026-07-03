import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate as pgMigrate } from "drizzle-orm/postgres-js/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsFolder = resolve(here, "../drizzle");

export async function migrate(
  db: PostgresJsDatabase<typeof schema>,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  await pgMigrate(db, {
    migrationsFolder,
    migrationsSchema: "release_ledger",
  });
}
