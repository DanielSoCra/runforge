import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/db.js";
import * as schema from "../../src/schema.js";
import { createReleaseLedgerWriter } from "../../src/ledger.js";
import type { ReleaseLedgerWriter } from "../../src/ledger.js";
import type { Sql } from "../../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../../drizzle");

export interface TempLedger {
  writer: ReleaseLedgerWriter;
  cleanup: () => Promise<void>;
}

export async function makeTempLedger(): Promise<TempLedger> {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await pgliteMigrate(pgliteDb, {
    migrationsFolder,
    migrationsSchema: "release_ledger",
  });

  const writer = createReleaseLedgerWriter({
    db: pgliteDb as unknown as Db,
    sql: {
      end: async () => {
        await client.close();
      },
    } as unknown as Sql,
  });

  return {
    writer,
    async cleanup() {
      await writer.close();
    },
  };
}
