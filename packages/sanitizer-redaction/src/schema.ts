import { pgSchema, text } from "drizzle-orm/pg-core";

/**
 * The protected-store pointer table. This is a SECOND drizzle definition of the
 * SAME physical table the decision-index migration creates
 * (`decision_index.protected_refs`) — one physical table, two drizzle defs, as
 * it was under sqlite. The decision-index package owns the migration; this def
 * is the access surface the ProtectedStore writes/reads through the shared
 * writer connection.
 */
export const decisionIndex = pgSchema("decision_index");

export const protectedRefs = decisionIndex.table("protected_refs", {
  ulid: text("ulid").primaryKey(),
  decision_id: text("decision_id"),
  field: text("field").notNull(),
  class: text("class").notNull(),
  created_at: text("created_at").notNull(),
});
