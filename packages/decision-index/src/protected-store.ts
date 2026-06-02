import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { SensitivityClass } from "@auto-claude/decision-protocol";
import type { Db } from "./db.js";
import { protectedRefs } from "./schema.js";

export class ProtectedIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedIntegrityError";
  }
}

export interface ProtectedStoreOptions {
  /** base64-encoded 32-byte AES-256 key (env PM_PROTECTED_KEY / Keychain in prod). */
  key: string;
  /** directory where <ulid>.enc blobs live (default ~/.agents/pm/protected). */
  dir: string;
  db: Db;
  clock?: () => Date;
}

export interface PutArgs {
  decision_id: string;
  field: string;
  class: SensitivityClass;
  plaintext: string;
}

const REF_PREFIX = "protected://";
const ALGO = "aes-256-gcm";
const MAGIC = Buffer.from("PMPS2\0"); // versioned blob header (v2: HKDF subkeys + AAD binding)
const HKDF_HASH = "sha256";
const SALT = Buffer.from("pm-cockpit-protected-store"); // fixed, non-secret HKDF salt

interface BoundMeta {
  ulid: string;
  decision_id: string;
  field: string;
  class: string;
}

/**
 * Encrypted, integrity-protected store for phi/secret values. The SQLite index
 * holds only `protected://<ulid>` + class (via protected_refs). Blobs live as
 * files OUTSIDE SQLite, each carrying its own keyed-HMAC integrity tag so a
 * plaintext hash never needs to live in the DB.
 *
 * Crypto (Finding 8):
 *  - The master key is NEVER used directly. Three independent subkeys are
 *    derived via HKDF: encKey (AES-256-GCM), macKey (blob HMAC), respKey
 *    (response-hash HMAC). Same-key-for-cipher-and-MAC is avoided.
 *  - The stable metadata (ulid|decision_id|field|class) is bound as BOTH the
 *    GCM AAD and the HMAC input, so a relabelled/relocated blob fails to
 *    decrypt/verify (no confused-deputy).
 *
 * Blob layout: MAGIC | iv(12) | gcmTag(16) | hmac(32) | ciphertext
 * AAD = MAGIC | meta;  HMAC covers MAGIC | meta | iv | gcmTag | ciphertext.
 */
export class ProtectedStore {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;
  private readonly respKey: Buffer;
  private readonly dir: string;
  private readonly db: Db;
  private readonly clock: () => Date;

  constructor(opts: ProtectedStoreOptions) {
    const key = Buffer.from(opts.key, "base64");
    if (key.length !== 32) {
      throw new Error(
        `PM_PROTECTED_KEY must decode to 32 bytes (got ${key.length}); provide a base64 AES-256 key`,
      );
    }
    this.encKey = this.subkey(key, "enc");
    this.macKey = this.subkey(key, "mac");
    this.respKey = this.subkey(key, "response-hash");
    this.dir = opts.dir;
    this.db = opts.db;
    this.clock = opts.clock ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });
  }

  /** HKDF-derive a 32-byte subkey from the master key for a labelled purpose. */
  private subkey(master: Buffer, label: string): Buffer {
    return Buffer.from(hkdfSync(HKDF_HASH, master, SALT, Buffer.from(`pmps:${label}`), 32));
  }

  /** Canonical, length-prefixed encoding of the bound metadata. */
  private metaBytes(m: BoundMeta): Buffer {
    const parts = [m.ulid, m.decision_id, m.field, m.class];
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const b = Buffer.from(p, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length, 0);
      chunks.push(len, b);
    }
    return Buffer.concat(chunks);
  }

  put(args: PutArgs): string {
    const id = ulid();
    const meta: BoundMeta = {
      ulid: id,
      decision_id: args.decision_id,
      field: args.field,
      class: args.class,
    };
    const metaBytes = this.metaBytes(meta);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.encKey, iv);
    cipher.setAAD(Buffer.concat([MAGIC, metaBytes]));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(args.plaintext, "utf8")),
      cipher.final(),
    ]);
    const gcmTag = cipher.getAuthTag();
    const hmac = createHmac("sha256", this.macKey)
      .update(MAGIC)
      .update(metaBytes)
      .update(iv)
      .update(gcmTag)
      .update(ciphertext)
      .digest();
    const blob = Buffer.concat([MAGIC, iv, gcmTag, hmac, ciphertext]);
    writeFileSync(this.blobPath(id), blob);

    this.db
      .insert(protectedRefs)
      .values({
        ulid: id,
        decision_id: args.decision_id,
        field: args.field,
        class: args.class,
        created_at: this.clock().toISOString(),
      })
      .run();

    return REF_PREFIX + id;
  }

  /**
   * Keyed-HMAC over canonical content, using a subkey distinct from the cipher
   * and blob-MAC keys. Used for the answered-once response hash so a low-entropy
   * PHI/secret answer never yields a guessable plaintext-derived (bare SHA-256)
   * hash in SQLite (Finding 3 / §61). Deterministic -> idempotent replay still
   * matches.
   */
  responseHmac(canonical: string): string {
    return createHmac("sha256", this.respKey).update(canonical).digest("hex");
  }

  get(ref: string): string {
    const { iv, gcmTag, ciphertext, meta } = this.readVerified(ref);
    const decipher = createDecipheriv(ALGO, this.encKey, iv);
    decipher.setAAD(Buffer.concat([MAGIC, this.metaBytes(meta)]));
    decipher.setAuthTag(gcmTag);
    try {
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    } catch {
      throw new ProtectedIntegrityError(`GCM auth failed for ${ref}`);
    }
  }

  verifyIntegrity(ref: string): true {
    this.readVerified(ref);
    return true;
  }

  /** Look up the bound metadata for a ref from protected_refs. */
  private metaOf(id: string): BoundMeta {
    const row = this.db
      .select()
      .from(protectedRefs)
      .where(eq(protectedRefs.ulid, id))
      .all()[0];
    if (!row) {
      throw new ProtectedIntegrityError(`no protected_refs row for ${id}`);
    }
    return {
      ulid: row.ulid,
      decision_id: row.decision_id ?? "",
      field: row.field,
      class: row.class,
    };
  }

  private readVerified(
    ref: string,
  ): { iv: Buffer; gcmTag: Buffer; ciphertext: Buffer; meta: BoundMeta } {
    const id = this.ulidOf(ref);
    const meta = this.metaOf(id);
    const metaBytes = this.metaBytes(meta);
    const path = this.blobPath(id);
    if (!existsSync(path)) {
      throw new ProtectedIntegrityError(`protected blob missing: ${ref}`);
    }
    const blob = readFileSync(path);
    const mLen = MAGIC.length;
    if (blob.length < mLen + 12 + 16 + 32) {
      throw new ProtectedIntegrityError(`protected blob truncated: ${ref}`);
    }
    if (!blob.subarray(0, mLen).equals(MAGIC)) {
      throw new ProtectedIntegrityError(`bad blob header: ${ref}`);
    }
    let off = mLen;
    const iv = blob.subarray(off, (off += 12));
    const gcmTag = blob.subarray(off, (off += 16));
    const hmac = blob.subarray(off, (off += 32));
    const ciphertext = blob.subarray(off);
    const expected = createHmac("sha256", this.macKey)
      .update(MAGIC)
      .update(metaBytes)
      .update(iv)
      .update(gcmTag)
      .update(ciphertext)
      .digest();
    if (expected.length !== hmac.length || !timingSafeEqual(expected, hmac)) {
      throw new ProtectedIntegrityError(`HMAC mismatch for ${ref}`);
    }
    return { iv, gcmTag, ciphertext, meta };
  }

  private ulidOf(ref: string): string {
    if (!ref.startsWith(REF_PREFIX)) {
      throw new ProtectedIntegrityError(`not a protected ref: ${ref}`);
    }
    return ref.slice(REF_PREFIX.length);
  }

  private blobPath(id: string): string {
    return join(this.dir, `${id}.enc`);
  }
}

export function defaultProtectedDir(): string {
  const home = process.env.HOME ?? process.cwd();
  return join(home, ".agents", "pm", "protected");
}
