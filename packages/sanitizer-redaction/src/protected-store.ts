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
import { and, desc, eq } from "drizzle-orm";
import { monotonicFactory } from "ulid";

// Monotonic ulids: strictly increasing even within the same millisecond, so an ORDER BY
// ulid DESC reliably yields the newest ref (findRefForField). With plain ulid(), two puts in
// the same ms could mis-sort, breaking edit convergence (repeated retries of an edited field
// would keep minting fresh refs). Monotonic ids close that.
const ulid = monotonicFactory();
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { protectedRefs } from "./schema.js";

export type Db = PostgresJsDatabase<any>;

/**
 * A guarded-write runner injected by the decision-index writer factory: it runs
 * `fn` inside the writer mutex + per-tx advisory lock (and re-uses an open writer
 * tx when nested), so the protected_refs pointer insert goes through the SAME
 * single-writer primitive as every other mutation (spec §3.5a). When omitted (a
 * standalone ProtectedStore in tests), the insert runs directly on the shared db.
 */
export type RunWrite = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;

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
  /** guarded-write runner from the writer factory (spec §3.5a); optional in tests. */
  runWrite?: RunWrite;
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
  private readonly runWrite: RunWrite;
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
    // Default: run the insert directly on the shared db (standalone/tests). The
    // writer factory injects a guarded runner (mutex + advisory lock).
    this.runWrite = opts.runWrite ?? ((fn) => fn(opts.db));
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

  async put(args: PutArgs): Promise<string> {
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

    // §3.5a: the pointer insert goes through the guarded writer primitive.
    await this.runWrite(async (tx) => {
      await tx.insert(protectedRefs).values({
        ulid: id,
        decision_id: args.decision_id,
        field: args.field,
        class: args.class,
        created_at: this.clock().toISOString(),
      });
    });

    return REF_PREFIX + id;
  }

  responseHmac(canonical: string): string {
    return createHmac("sha256", this.respKey).update(canonical).digest("hex");
  }

  async get(ref: string): Promise<string> {
    const { iv, gcmTag, ciphertext, meta } = await this.readVerified(ref);
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

  async verifyIntegrity(ref: string): Promise<true> {
    await this.readVerified(ref);
    return true;
  }

  /**
   * The MOST RECENT protected ref for a (decision_id, field), if one was already stored.
   * Lets a sanitizer be idempotent across retries: reuse the prior ref instead of minting a
   * duplicate. Ordered newest-first (by ulid, which is time-monotonic) so that after an edit
   * minted a fresh ref, the latest is returned — callers compare its plaintext to decide
   * reuse-vs-mint, which converges. Returns undefined when no row exists. Reads the pointer
   * table only — no blob I/O, no decryption.
   */
  async findRefForField(decision_id: string, field: string): Promise<string | undefined> {
    const row = (
      await this.db
        .select()
        .from(protectedRefs)
        .where(and(eq(protectedRefs.decision_id, decision_id), eq(protectedRefs.field, field)))
        .orderBy(desc(protectedRefs.ulid))
        .limit(1)
    )[0];
    return row ? REF_PREFIX + row.ulid : undefined;
  }

  private async metaOf(id: string): Promise<BoundMeta> {
    const row = (
      await this.db.select().from(protectedRefs).where(eq(protectedRefs.ulid, id))
    )[0];
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

  private async readVerified(
    ref: string,
  ): Promise<{ iv: Buffer; gcmTag: Buffer; ciphertext: Buffer; meta: BoundMeta }> {
    const id = this.ulidOf(ref);
    const meta = await this.metaOf(id);
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
