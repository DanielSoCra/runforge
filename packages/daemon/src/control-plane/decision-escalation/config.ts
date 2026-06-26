/**
 * Decision-escalation env reader — the ONE place the `AUTO_CLAUDE_DECISION_*`
 * environment variables are parsed (per fold plan Task 5). It produces the
 * options the daemon passes to `new DecisionIndexManager(...)`:
 *
 *   - AUTO_CLAUDE_DECISION_INDEX_ENABLED   (default false; truthy = 1/true/yes)
 *   - AUTO_CLAUDE_DECISION_INDEX_PATH      (default `decision-index.sqlite`,
 *       resolved ABSOLUTE against stateDir)
 *   - AUTO_CLAUDE_DECISION_PROTECTED_DIR   (default `decision-protected/`,
 *       resolved ABSOLUTE against stateDir)
 *   - AUTO_CLAUDE_DECISION_PROTECTED_KEY   (base64 AES-256; if unset, generate 32
 *       random bytes ONCE and persist to `<stateDir>/decision-protected.key`,
 *       then reuse on subsequent boots)
 *
 * The key is only generated/persisted when no explicit env key is supplied, so a
 * deployment can pin a managed secret without leaving a key file on disk.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface DecisionIndexEnvConfig {
  enabled: boolean;
  /** Postgres URL the writer connects to (AUTO_CLAUDE_DATABASE_URL). */
  databaseUrl: string;
  protectedKey: string;
  protectedDir: string;
}

/** Legacy sqlite store path — cutover preflight only; the runtime NEVER opens it. */
const DEFAULT_LEGACY_SQLITE_PATH = 'decision-index.sqlite';
const DEFAULT_PROTECTED_DIR = 'decision-protected';
const KEY_FILE = 'decision-protected.key';

/** Truthy env parse: 1/true/yes (case-insensitive, whitespace-tolerant). */
function envEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Resolve `value` against `base` when relative; pass absolute through unchanged. */
function resolveAgainst(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

/**
 * Load or generate the base64 AES-256 protected-store key. An explicit env key
 * is used verbatim (no file written). Otherwise a persisted key is reused, or a
 * fresh 32-byte key is generated, persisted under `stateDir`, and returned.
 */
function loadOrGenerateKey(stateDir: string): string {
  const explicit = process.env.AUTO_CLAUDE_DECISION_PROTECTED_KEY;
  if (explicit !== undefined && explicit !== '') return explicit;

  const keyPath = join(stateDir, KEY_FILE);
  if (existsSync(keyPath)) {
    const persisted = readFileSync(keyPath, 'utf-8').trim();
    if (persisted !== '') return persisted;
  }
  const key = randomBytes(32).toString('base64');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  return key;
}

/**
 * Read the decision-escalation configuration from the environment, resolving all
 * paths absolute against `stateDir`.
 *
 * Fail-closed invariant (FIX 1): when the flag is OFF this function does ZERO
 * filesystem I/O. It returns a disabled config with an EMPTY `protectedKey`
 * placeholder and never touches `stateDir` — so a flag-OFF daemon can never
 * write `state/decision-protected.key`, and a read-only/full/permission-denied
 * stateDir can never abort boot. The protected key is generated+persisted ONLY
 * when the flag is ON and no explicit env key is supplied (key-file logic lives
 * here, the one place these env vars are parsed); the daemon constructs the
 * manager from this config inside a guarded boot block (see daemon.ts).
 */
export function readDecisionIndexConfig(stateDir: string): DecisionIndexEnvConfig {
  // NOTE (spec §3.8 / §9): the default stays OFF for the store migration. The
  // default-ON opt-out flip is an operator-gated follow-up (plan Task 11b).
  const enabled = envEnabled(process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED);
  // The decision index reuses the daemon's existing Postgres (no separate sqlite
  // file). Read it only when enabled, so a flag-OFF daemon does ZERO extra work.
  const databaseUrl = enabled
    ? (process.env.AUTO_CLAUDE_DATABASE_URL ?? '')
    : '';
  const protectedDir = resolveAgainst(
    stateDir,
    process.env.AUTO_CLAUDE_DECISION_PROTECTED_DIR ?? DEFAULT_PROTECTED_DIR,
  );
  // Disabled => NO filesystem I/O at all. The key is only needed in the manager's
  // enabled branch, so a placeholder/empty key is sufficient and keeps boot inert.
  const protectedKey = enabled ? loadOrGenerateKey(stateDir) : '';
  if (enabled) assertLegacyStoreCutoverAcked(stateDir);
  return { enabled, databaseUrl, protectedKey, protectedDir };
}

/**
 * Greenfield cutover preflight (spec §4) — fail-closed, NATIVE-FREE. If a legacy
 * sqlite decision store FILE still exists, it may hold unanswered escalations the
 * Postgres greenfield migration would silently abandon. Refuse to boot the index
 * unless the operator acknowledges the cutover (AUTO_CLAUDE_DECISION_INDEX_CUTOVER_ACK).
 *
 * This is a pure `fs.existsSync` check — it MUST NOT open the sqlite file (that
 * would reintroduce the very better-sqlite3 native module the migration removes,
 * codex round-2 Critical). Row salvage is a separate optional operator tool.
 */
function assertLegacyStoreCutoverAcked(stateDir: string): void {
  const acked = envEnabled(process.env.AUTO_CLAUDE_DECISION_INDEX_CUTOVER_ACK);
  if (acked) return;
  const legacyPath = resolveAgainst(
    stateDir,
    process.env.AUTO_CLAUDE_DECISION_INDEX_PATH ?? DEFAULT_LEGACY_SQLITE_PATH,
  );
  if (!existsSync(legacyPath)) return;
  throw new Error(
    `decision-index: a legacy sqlite decision store exists at ${legacyPath}; it may hold ` +
      `unanswered escalations. The store now lives in Postgres (greenfield) — run the one-shot ` +
      `export tool to salvage rows, OR set AUTO_CLAUDE_DECISION_INDEX_CUTOVER_ACK=1 to proceed ` +
      `greenfield, then delete the file. (The runtime never opens the sqlite file.)`,
  );
}
