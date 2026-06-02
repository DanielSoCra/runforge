import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";

export interface TempDb {
  db: Db;
  path: string;
  dir: string;
  cleanup: () => void;
}

/** Create a migrated temp ON-DISK SQLite db (never :memory: — WAL must be real). */
export function makeTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "pm-index-"));
  const path = join(dir, "pm.sqlite");
  const db = openDb({ path });
  migrate(db);
  return {
    db,
    path,
    dir,
    cleanup() {
      try {
        db.$client.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Deterministic test key: base64 of 32 zero-bytes (matches CI env). */
export const TEST_PROTECTED_KEY = Buffer.alloc(32).toString("base64");
