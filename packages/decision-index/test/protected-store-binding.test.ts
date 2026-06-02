import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { ProtectedStore, ProtectedIntegrityError } from "../src/protected-store.js";
import { protectedRefs } from "../src/schema.js";

/**
 * MINOR 8 — protected-store crypto integrity must be bound to the stable
 * metadata (ulid/decision_id/field/class), and the AES-GCM key must be distinct
 * from the HMAC key (separate HKDF subkeys). Otherwise a blob can be relabelled
 * (its metadata row swapped) or relocated to another ref and still decrypt — a
 * confused-deputy leak for the confidentiality statute PHI.
 */
describe("protected store: integrity bound to metadata (Finding 8)", () => {
  let dir: string;
  let store: ProtectedStore;
  let t: TempDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-prot-bind-"));
    t = makeTempDb();
    store = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir, db: t.db });
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a value with its bound metadata", () => {
    const ref = store.put({ decision_id: "dA", field: "context", class: "phi", plaintext: "secret-x" });
    expect(store.get(ref)).toBe("secret-x");
  });

  it("swapping the stored metadata (field/class) makes decryption FAIL", () => {
    const ref = store.put({ decision_id: "dA", field: "context", class: "phi", plaintext: "secret-x" });
    const id = ref.replace("protected://", "");

    // attacker relabels the metadata row (e.g. downgrades class / changes field)
    t.db
      .update(protectedRefs)
      .set({ field: "question", class: "internal" })
      .where(eq(protectedRefs.ulid, id))
      .run();

    expect(() => store.get(ref)).toThrow(ProtectedIntegrityError);
    expect(() => store.verifyIntegrity(ref)).toThrow(ProtectedIntegrityError);
  });

  it("swapping decision_id on the metadata row makes decryption FAIL", () => {
    const ref = store.put({ decision_id: "dA", field: "context", class: "phi", plaintext: "secret-x" });
    const id = ref.replace("protected://", "");
    t.db.update(protectedRefs).set({ decision_id: "dB" }).where(eq(protectedRefs.ulid, id)).run();
    expect(() => store.get(ref)).toThrow(ProtectedIntegrityError);
  });

  it("relocating a blob to another ulid (ref) makes decryption FAIL (ulid is bound)", () => {
    const refA = store.put({ decision_id: "dA", field: "context", class: "phi", plaintext: "secret-A" });
    const refB = store.put({ decision_id: "dB", field: "context", class: "phi", plaintext: "secret-B" });
    const idA = refA.replace("protected://", "");
    const idB = refB.replace("protected://", "");

    // move blob A's bytes onto B's path -> reading refB must fail (ulid mismatch)
    const blobA = readFileSync(join(dir, `${idA}.enc`));
    writeFileSync(join(dir, `${idB}.enc`), blobA);
    expect(() => store.get(refB)).toThrow(ProtectedIntegrityError);
  });
});
