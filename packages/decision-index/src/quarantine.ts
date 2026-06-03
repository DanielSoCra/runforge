import type { Db } from "./db.js";
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
  record(rec: QuarantineRecord): void;
}

/** SQLite-backed content-free rejected-ingestion log (§5.1). */
export class SqliteQuarantine implements Quarantine {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  record(rec: QuarantineRecord): void {
    this.db
      .insert(quarantineEvents)
      .values({
        source_url: rec.source_url ?? null,
        source_event_id: rec.source_event_id ?? null,
        reason: rec.reason,
        missing_paths: rec.missingPaths ? JSON.stringify(rec.missingPaths) : null,
        created_at: this.clock().toISOString(),
      })
      .run();
  }
}

/** In-memory fakeable sink for tests/drivers that don't want a DB. */
export class FakeQuarantine implements Quarantine {
  readonly records: QuarantineRecord[] = [];
  record(rec: QuarantineRecord): void {
    this.records.push(rec);
  }
}
