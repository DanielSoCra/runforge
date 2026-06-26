import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema.js";

/**
 * Task 2 guard: the sqlite-core -> pg-core port must keep every table exported,
 * place them all in the dedicated `decision_index` Postgres schema, and apply
 * the spec §3.2 column-type mapping (boolean / bigint-identity / text-timestamp).
 */
describe("schema-shape (pg-core port)", () => {
  const tables = {
    decisions: schema.decisions,
    decisionResponses: schema.decisionResponses,
    appliedTransitions: schema.appliedTransitions,
    auditLog: schema.auditLog,
    outbox: schema.outbox,
    workerSessions: schema.workerSessions,
    protectedRefs: schema.protectedRefs,
    quarantineEvents: schema.quarantineEvents,
  };

  it("exports every table inside the decision_index schema", () => {
    for (const [name, t] of Object.entries(tables)) {
      const cfg = getTableConfig(t);
      expect(cfg.schema, `${name} schema`).toBe("decision_index");
    }
  });

  it("maps integer({mode:boolean}) columns to pg boolean", () => {
    expect(schema.decisions.stale.getSQLType()).toBe("boolean");
    expect(schema.decisions.pinned.getSQLType()).toBe("boolean");
    expect(schema.decisions.muted.getSQLType()).toBe("boolean");
    expect(schema.outbox.superseded.getSQLType()).toBe("boolean");
  });

  it("maps autoincrement PKs to bigint generated-always-as-identity", () => {
    expect(schema.auditLog.id.getSQLType()).toBe("bigint");
    expect(schema.auditLog.id.primary).toBe(true);
    expect(schema.quarantineEvents.id.getSQLType()).toBe("bigint");
    expect(schema.quarantineEvents.id.primary).toBe(true);
  });

  it("keeps ISO-8601 timestamp fields as text (no behavioral drift)", () => {
    expect(schema.decisions.created_at.getSQLType()).toBe("text");
    expect(schema.decisions.updated_at.getSQLType()).toBe("text");
    expect(schema.outbox.claimed_at.getSQLType()).toBe("text");
    expect(schema.auditLog.at.getSQLType()).toBe("text");
  });

  it("keeps the deterministic/text primary keys as text", () => {
    expect(schema.decisions.decision_id.getSQLType()).toBe("text");
    expect(schema.outbox.id.getSQLType()).toBe("text");
    expect(schema.protectedRefs.ulid.getSQLType()).toBe("text");
  });
});
