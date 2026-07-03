import { pgSchema, text, bigint, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Dedicated Postgres schema namespace for the per-deployment release ledger. */
export const releaseLedger = pgSchema("release_ledger");

/**
 * Append-only release event journal. A single release is the ordered run of
 * events sharing a release_id; there is NO mutable per-release row (a proposal
 * appended before the decision is just an earlier event). The Last-Released
 * Marker is DERIVED from the most recent `released` event — never stored twice.
 */
export const releaseEvents = releaseLedger.table("release_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  release_id: text("release_id").notNull(),
  deployment: text("deployment").notNull(),
  event: text("event").notNull(),            // proposal | decision | attempt | execution | completion | resolved
  target_revision: text("target_revision"),  // nullable (decision/resolved events carry none)
  detail_json: text("detail_json"),          // structured-safe: proposal | {answer} | {shape} | {outcome}
  at: text("at").notNull(),
}, (t) => ({
  // ATOMIC proposal-uniqueness: at most one `proposal` row per release_id. Makes
  // `appendProposalIfAbsent` race-safe (two concurrent proposes cannot both insert
  // a proposal) — the DB rejects the second at COMMIT, not a read-then-append check.
  oneProposalPerRelease: uniqueIndex("release_events_one_proposal_per_release")
    .on(t.release_id)
    .where(sql`${t.event} = 'proposal'`),
  // ATOMIC attempt-uniqueness: at most one `attempt` row per release_id. Makes the
  // execution `attempt` an atomic CLAIM (`appendAttemptIfAbsent`) so two concurrent
  // release sweeps for the same approved release cannot both begin execution — only
  // the caller whose insert wins the unique index performs promote/fireTrigger.
  oneAttemptPerRelease: uniqueIndex("release_events_one_attempt_per_release")
    .on(t.release_id)
    .where(sql`${t.event} = 'attempt'`),
}));
