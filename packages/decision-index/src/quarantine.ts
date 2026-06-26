import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { quarantineEvents } from "./schema.js";

export interface QuarantineRecord {
  decision_id?: string;
  source_url?: string;
  source_event_id?: string;
  reason: string;
  /** path NAMES only — never field values. */
  missingPaths?: string[];
}

export interface Quarantine {
  record(rec: QuarantineRecord): Promise<void>;
}

/** Postgres-backed content-free rejected-ingestion log (§5.1). */
export class PgQuarantine implements Quarantine {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(rec: QuarantineRecord): Promise<void> {
    // Route through the guarded writer primitive (spec §3.5a — every mutation
    // through withTx, never a bare insert).
    await withTx(this.db, async (tx) => {
      await tx.insert(quarantineEvents).values({
        source_url: rec.source_url ?? null,
        source_event_id: rec.source_event_id ?? null,
        reason: rec.reason,
        missing_paths: rec.missingPaths ? JSON.stringify(rec.missingPaths) : null,
        created_at: this.clock().toISOString(),
      });
    });
  }
}

/** In-memory fakeable sink for tests/drivers that don't want a DB. */
export class FakeQuarantine implements Quarantine {
  readonly records: QuarantineRecord[] = [];
  async record(rec: QuarantineRecord): Promise<void> {
    this.records.push(rec);
  }
}
