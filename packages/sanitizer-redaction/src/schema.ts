import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const protectedRefs = sqliteTable("protected_refs", {
  ulid: text("ulid").primaryKey(),
  decision_id: text("decision_id"),
  field: text("field").notNull(),
  class: text("class").notNull(),
  created_at: text("created_at").notNull(),
});
