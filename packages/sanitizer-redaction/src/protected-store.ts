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
import { type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { protectedRefs } from "./schema.js";

export type Db = BetterSQLite3Database<any>;

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
  class: string;
  plaintext: string;
}

const REF_PREFIX = "protected://";
const ALGO = "aes-256-gcm";
const MAGIC = Buffer.from("PMPS2\0");
const HKDF_HASH = "sha256";
const SALT = Buffer.from("pm-cockpit-protected-store");

interface BoundMeta {
  ulid: string;
  decision_id: string;
  field: string;
  class: string;
}

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

  private subkey(master: Buffer, label: string): Buffer {
    return Buffer.from(hkdfSync(HKDF_HASH, master, SALT, Buffer.from(`pmps:${label}`), 32));
  }

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
