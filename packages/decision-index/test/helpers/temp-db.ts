import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/db.js";
import * as schema from "../../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../../drizzle");

export interface PgliteTestDb {
  /**
   * Drizzle handle over a fresh in-memory PGlite (real Postgres, WASM), typed as
   * the production `Db` so it drops straight into the writer/apply/withTx
   * surface. PGlite and postgres-js share the drizzle query API at runtime; the
   * withTx advisory-lock probe normalizes the one `execute()` shape divergence.
   */
  db: Db;
  /** Raw PGlite client (for SELECTs against information_schema, raw exec, etc.). */
  client: PGlite;
  cleanup: () => Promise<void>;
}

/**
 * Create a migrated, in-memory PGlite database (real Postgres MVCC, advisory
 * locks, RETURNING, FOR UPDATE — compiled to WASM, no Docker). Replaces the old
 * on-disk-sqlite `makeTempDb`. Applies the SAME generated `decision_index`
 * migrations the production postgres-js path uses, via the PGlite migrator.
 */
export async function makePgliteDb(): Promise<PgliteTestDb> {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await pgliteMigrate(pgliteDb, {
    migrationsFolder,
    migrationsSchema: "decision_index",
  });
  return {
    db: pgliteDb as unknown as Db,
    client,
    async cleanup() {
      await client.close();
    },
  };
}

/** Deterministic test key: base64 of 32 zero-bytes (matches CI env). */
export const TEST_PROTECTED_KEY = Buffer.alloc(32).toString("base64");
