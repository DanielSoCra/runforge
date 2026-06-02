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
  dbPath: string;
  protectedKey: string;
  protectedDir: string;
}

const DEFAULT_DB_PATH = 'decision-index.sqlite';
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
 * paths absolute against `stateDir`. The protected key is generated+persisted on
 * first run only when neither an env key nor a key file is present.
 */
export function readDecisionIndexConfig(stateDir: string): DecisionIndexEnvConfig {
  const enabled = envEnabled(process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED);
  const dbPath = resolveAgainst(
    stateDir,
    process.env.AUTO_CLAUDE_DECISION_INDEX_PATH ?? DEFAULT_DB_PATH,
  );
  const protectedDir = resolveAgainst(
    stateDir,
    process.env.AUTO_CLAUDE_DECISION_PROTECTED_DIR ?? DEFAULT_PROTECTED_DIR,
  );
  const protectedKey = loadOrGenerateKey(stateDir);
  return { enabled, dbPath, protectedKey, protectedDir };
}
