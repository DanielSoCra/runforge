import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { openDb, withTx, type Db, type Sql } from "./db.js";
import { migrate } from "./migrate.js";
import { releaseEvents } from "./schema.js";

export type ReleaseEventKind =
  | "proposal"
  | "decision"
  | "attempt"
  | "execution"
  | "completion"
  | "resolved";

export type ReleaseOutcome =
  | "released"
  | "triggered-awaiting"
  | "recorded-awaiting-human"
  | "failed";

export interface AppendReleaseEvent {
  releaseId: string;
  deployment: string;
  event: ReleaseEventKind;
  targetRevision: string | null;
  detail: Record<string, unknown>;
  at?: string;
}

export interface ReleaseEventRow {
  id: number;
  releaseId: string;
  deployment: string;
  event: ReleaseEventKind;
  targetRevision: string | null;
  detail: Record<string, unknown>;
  at: string;
}

export interface ReleaseLedgerWriter {
  append(e: AppendReleaseEvent): Promise<void>;
  appendProposalIfAbsent(
    e: AppendReleaseEvent & { event: "proposal" },
  ): Promise<boolean>;
  /**
   * Atomic single-attempt-per-release CLAIM (partial unique index on
   * `event='attempt'`). Returns `true` iff THIS caller inserted the attempt row;
   * `false` if another concurrent sweep already claimed it. Mirrors
   * `appendProposalIfAbsent` (`ON CONFLICT DO NOTHING` + rowCount) and lets the
   * executor gate promote/fireTrigger on winning the claim so two concurrent
   * release sweeps for one approved release cannot double-execute.
   *
   * Optional on the interface only because the in-memory test doubles the
   * release-lane gates drive are single-threaded (no race to guard); the executor
   * falls back to a plain `append` when a writer does not model the atomic claim.
   */
  appendAttemptIfAbsent?(
    e: AppendReleaseEvent & { event: "attempt" },
  ): Promise<boolean>;
  reader(): ReleaseLedgerReader;
  close(): Promise<void>;
}

export interface ReleaseLedgerReader {
  eventsForRelease(
    deployment: string,
    releaseId: string,
  ): Promise<ReleaseEventRow[]>;
  lastReleasedMarker(deployment: string): Promise<string | undefined>;
  latestOutcome(
    deployment: string,
    releaseId: string,
  ): Promise<ReleaseOutcome | undefined>;
  openReleases(): Promise<
    { deployment: string; releaseId: string; detail: Record<string, unknown> }[]
  >;
  /** True iff any decision event for the deployment has an approve-family answer. */
  hasPriorApprovedRelease(deployment: string): Promise<boolean>;
  /** True iff any decision event for the deployment carries debutAuthorized: true. */
  hasDebutAuthorization(deployment: string): Promise<boolean>;
}

function parseDetail(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toRow(row: typeof releaseEvents.$inferSelect): ReleaseEventRow {
  return {
    id: row.id,
    releaseId: row.release_id,
    deployment: row.deployment,
    event: row.event as ReleaseEventKind,
    targetRevision: row.target_revision ?? null,
    detail: parseDetail(row.detail_json),
    at: row.at,
  };
}

class Reader implements ReleaseLedgerReader {
  constructor(private readonly db: Db) {}

  async eventsForRelease(
    deployment: string,
    releaseId: string,
  ): Promise<ReleaseEventRow[]> {
    const rows = await this.db
      .select()
      .from(releaseEvents)
      .where(
        and(
          eq(releaseEvents.deployment, deployment),
          eq(releaseEvents.release_id, releaseId),
        ),
      )
      .orderBy(releaseEvents.id);
    return rows.map(toRow);
  }

  async lastReleasedMarker(deployment: string): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(releaseEvents)
      .where(
        and(
          eq(releaseEvents.deployment, deployment),
          inArray(releaseEvents.event, ["execution", "completion"]),
        ),
      )
      .orderBy(desc(releaseEvents.id));
    for (const row of rows) {
      const detail = parseDetail(row.detail_json);
      if (detail.outcome === "released") {
        return row.target_revision ?? undefined;
      }
    }
    return undefined;
  }

  async latestOutcome(
    deployment: string,
    releaseId: string,
  ): Promise<ReleaseOutcome | undefined> {
    const rows = await this.db
      .select()
      .from(releaseEvents)
      .where(
        and(
          eq(releaseEvents.deployment, deployment),
          eq(releaseEvents.release_id, releaseId),
          inArray(releaseEvents.event, ["execution", "completion"]),
        ),
      )
      .orderBy(desc(releaseEvents.id))
      .limit(1);
    if (rows.length === 0) return undefined;
    const detail = parseDetail(rows[0]!.detail_json);
    const outcome = detail.outcome;
    if (
      outcome === "released" ||
      outcome === "triggered-awaiting" ||
      outcome === "recorded-awaiting-human" ||
      outcome === "failed"
    ) {
      return outcome as ReleaseOutcome;
    }
    return undefined;
  }

  async openReleases(): Promise<
    { deployment: string; releaseId: string; detail: Record<string, unknown> }[]
  > {
    const rows = await this.db
      .select()
      .from(releaseEvents)
      .orderBy(releaseEvents.id);
    const byRelease = new Map<string, typeof releaseEvents.$inferSelect[]>();
    for (const row of rows) {
      const arr = byRelease.get(row.release_id) ?? [];
      arr.push(row);
      byRelease.set(row.release_id, arr);
    }
    const out: {
      deployment: string;
      releaseId: string;
      detail: Record<string, unknown>;
    }[] = [];
    for (const [releaseId, events] of byRelease) {
      const proposal = events.find((r) => r.event === "proposal");
      const resolved = events.some((r) => r.event === "resolved");
      if (proposal && !resolved) {
        out.push({
          deployment: proposal.deployment,
          releaseId,
          detail: parseDetail(proposal.detail_json),
        });
      }
    }
    return out;
  }

  async hasPriorApprovedRelease(deployment: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(releaseEvents)
      .where(
        and(
          eq(releaseEvents.deployment, deployment),
          eq(releaseEvents.event, "decision"),
        ),
      );
    return rows.some((r) => {
      const detail = parseDetail(r.detail_json);
      return detail.answer === "approve" || detail.answer === "approve-with-debut";
    });
  }

  async hasDebutAuthorization(deployment: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(releaseEvents)
      .where(
        and(
          eq(releaseEvents.deployment, deployment),
          eq(releaseEvents.event, "decision"),
        ),
      );
    return rows.some((r) => {
      const detail = parseDetail(r.detail_json);
      return detail.answer === "approve-with-debut" && detail.debutAuthorized === true;
    });
  }
}

class Writer implements ReleaseLedgerWriter {
  private readonly db: Db;
  private readonly sql: Sql;

  constructor(handle: { db: Db; sql: Sql }) {
    this.db = handle.db;
    this.sql = handle.sql;
  }

  async append(e: AppendReleaseEvent): Promise<void> {
    await withTx(this.db, async (tx) => {
      await tx.insert(releaseEvents).values({
        release_id: e.releaseId,
        deployment: e.deployment,
        event: e.event,
        target_revision: e.targetRevision,
        detail_json: JSON.stringify(e.detail),
        at: e.at ?? new Date().toISOString(),
      });
    });
  }

  async appendProposalIfAbsent(
    e: AppendReleaseEvent & { event: "proposal" },
  ): Promise<boolean> {
    return withTx(this.db, async (tx) => {
      const result = await tx
        .insert(releaseEvents)
        .values({
          release_id: e.releaseId,
          deployment: e.deployment,
          event: e.event,
          target_revision: e.targetRevision,
          detail_json: JSON.stringify(e.detail),
          at: e.at ?? new Date().toISOString(),
        })
        .onConflictDoNothing({
          target: releaseEvents.release_id,
          where: sql`${releaseEvents.event} = 'proposal'`,
        })
        .returning({ id: releaseEvents.id });
      return result.length > 0;
    });
  }

  async appendAttemptIfAbsent(
    e: AppendReleaseEvent & { event: "attempt" },
  ): Promise<boolean> {
    return withTx(this.db, async (tx) => {
      const result = await tx
        .insert(releaseEvents)
        .values({
          release_id: e.releaseId,
          deployment: e.deployment,
          event: e.event,
          target_revision: e.targetRevision,
          detail_json: JSON.stringify(e.detail),
          at: e.at ?? new Date().toISOString(),
        })
        .onConflictDoNothing({
          target: releaseEvents.release_id,
          where: sql`${releaseEvents.event} = 'attempt'`,
        })
        .returning({ id: releaseEvents.id });
      return result.length > 0;
    });
  }

  reader(): ReleaseLedgerReader {
    return new Reader(this.db);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 }).catch(() => {});
  }
}

export function createReleaseLedgerWriter(handle: { db: Db; sql: Sql }): ReleaseLedgerWriter {
  return new Writer(handle);
}

export async function createReleaseLedger(opts: {
  databaseUrl: string;
  skipMigrate?: boolean;
}): Promise<ReleaseLedgerWriter> {
  const { db, sql } = await openDb({ url: opts.databaseUrl });
  try {
    if (!opts.skipMigrate) await migrate(db);
    return new Writer({ db, sql });
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
}
