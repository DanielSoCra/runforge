import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createDbClient } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsFolder = resolve(here, '../drizzle');

export async function runMigrations(
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  const client = createDbClient({ maxConnections: 1 });
  try {
    await migrate(client.db, { migrationsFolder });
  } finally {
    await client.sql.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await runMigrations();
}
