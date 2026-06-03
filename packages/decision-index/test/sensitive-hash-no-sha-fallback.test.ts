import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { apply, AnswerRejectedError } from "../src/state-machine.js";
import { decisionResponses } from "../src/schema.js";

const NOW = "2026-05-27T01:00:00.000Z";
const SENSITIVE_REF = "protected://01HSENSITIVEREF000000000000";

/**
 * C3 caveat — there must be NO plaintext-SHA fallback for a sensitive answer.
 * If apply() is called for a phi/secret answer WITHOUT a keyed-HMAC responseHash,
 * the prior code computed a bare SHA-256 over the canonical payload. Even though
 * the payload was already redacted, the contract is: a sensitive answer ALWAYS
 * requires the keyed HMAC, else it is REJECTED — never a SHA-over-canonical hash.
 */
describe("no plaintext-derived hash for a sensitive answer (Finding C3)", () => {
  let t: TempDb;
  beforeEach(() => {
    t = makeTempDb();
  });
  afterEach(() => t?.cleanup());

  function toViewed(id: string) {
    apply(t.db, id, "notify", { semanticKey: "slack", now: NOW });
    apply(t.db, id, "opened", { semanticKey: "daniel", now: NOW });
  }

  it("sensitive answer WITHOUT a keyed-HMAC hasher is REJECTED (no SHA-over-canonical hash, no response row)", () => {
    const id = seedDecision(t.db, {
      answer_schema_json: JSON.stringify({ kind: "json", schema: { type: "object" } }),
    });
    toViewed(id);

    // Sensitive answer, already redacted to a ref, but NO responseHash injected.
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-x",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-x",
        answer_ref: SENSITIVE_REF,
        // validate_value present + schema-valid so the I7 validation gate passes
        // and we isolate the C3 (missing-HMAC) rejection being asserted here.
        validate_value: {},
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
      // responseHash deliberately OMITTED
    });

    // rejected, not applied, no response row
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/keyed-HMAC|HMAC|hasher/i);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);

    // the SHA-256 a fallback would have produced over the canonical redacted
    // payload must NOT appear anywhere in SQLite.
    t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const canonical = `{"answer_ref":${JSON.stringify(SENSITIVE_REF)},"answer_value":null}`;
    const fallbackSha = createHash("sha256").update(canonical).digest("hex");
    const files = readdirSync(t.dir).filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite-"));
    for (const f of files) {
      const ascii = readFileSync(join(t.dir, f)).toString("latin1");
      expect(ascii.includes(fallbackSha), `${f} stored a SHA-fallback hash for a sensitive answer`).toBe(false);
    }
  });

  it("sensitive answer WITH a keyed-HMAC hasher is accepted; stored hash is the HMAC, not the SHA fallback", () => {
    const id = seedDecision(t.db, {
      answer_schema_json: JSON.stringify({ kind: "json", schema: { type: "object" } }),
    });
    toViewed(id);

    const hmac = (c: string) => createHash("sha256").update("KEYED|" + c).digest("hex");
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-ok",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-ok",
        answer_ref: SENSITIVE_REF,
        // I7: a sensitive json answer carries validate_value (never stored/hashed).
        validate_value: {},
        answer_sensitivity: "phi",
        answerer: "daniel",
        answered_at: NOW,
      },
      responseHash: hmac,
    });
    expect(r.applied).toBe(true);

    const resp = t.db.select().from(decisionResponses).all()[0]!;
    // CONFLICT-BYPASS FIX: the response_hash is now the keyed HMAC over the
    // LOGICAL answer identity ({answer_value:<validate_value>}) — NOT the volatile
    // answer_ref — so a phi replay (fresh ref each redaction) still matches. Here
    // validate_value is `{}`, canonicalized to {"answer_value":{}}. The C3
    // contract this test guards is UNCHANGED: the stored hash is the keyed HMAC,
    // never a bare SHA fallback (and never derived from the volatile ref).
    const logicalCanonical = `{"answer_value":{}}`;
    const refFallbackSha = createHash("sha256")
      .update(`{"answer_ref":${JSON.stringify(SENSITIVE_REF)},"answer_value":null}`)
      .digest("hex");
    expect(resp.response_hash).toBe(hmac(logicalCanonical));
    // not a bare SHA of the logical canonical, and not derived from the ref.
    expect(resp.response_hash).not.toBe(createHash("sha256").update(logicalCanonical).digest("hex"));
    expect(resp.response_hash).not.toBe(refFallbackSha);
  });
});
