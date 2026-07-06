import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readDecisionIndexConfig } from './config.js';

/**
 * The decision-escalation env reader is the ONE place RUNFORGE_DECISION_* env
 * vars are parsed. It resolves an absolute db path and defaults the protected
 * dir. Fail-closed invariant: when the flag is OFF it touches NOTHING on disk —
 * the protected key is generated/persisted lazily by DecisionIndexManager.init()
 * inside its enabled branch only (see manager.ts). Key generation here happens
 * ONLY when the flag is ON and no explicit env key is supplied.
 */
describe('readDecisionIndexConfig', () => {
  let stateDir: string;
  const SAVE = { ...process.env };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dec-cfg-'));
    delete process.env.RUNFORGE_DECISION_INDEX_ENABLED;
    delete process.env.RUNFORGE_DECISION_INDEX_PATH;
    delete process.env.RUNFORGE_DECISION_PROTECTED_KEY;
    delete process.env.RUNFORGE_DECISION_PROTECTED_DIR;
    delete process.env.RUNFORGE_DATABASE_URL;
    delete process.env.RUNFORGE_DECISION_INDEX_CUTOVER_ACK;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    process.env = { ...SAVE };
  });

  it('defaults to disabled when the flag is unset', () => {
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.enabled).toBe(false);
  });

  it('parses truthy enabled flag (case/whitespace tolerant)', () => {
    for (const v of ['true', '1', 'TRUE', ' true ', 'yes']) {
      process.env.RUNFORGE_DECISION_INDEX_ENABLED = v;
      expect(readDecisionIndexConfig(stateDir).enabled).toBe(true);
    }
    for (const v of ['false', '0', '', 'no', 'off']) {
      process.env.RUNFORGE_DECISION_INDEX_ENABLED = v;
      expect(readDecisionIndexConfig(stateDir).enabled).toBe(false);
    }
  });

  it('returns an empty databaseUrl when disabled (no Postgres URL read when flag OFF)', () => {
    // Even with RUNFORGE_DATABASE_URL set, a disabled daemon does ZERO extra
    // work and never surfaces the connection string.
    process.env.RUNFORGE_DATABASE_URL = 'postgres://user:pw@localhost:5432/ac';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.databaseUrl).toBe('');
  });

  it('reads databaseUrl from RUNFORGE_DATABASE_URL when enabled', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    process.env.RUNFORGE_DATABASE_URL = 'postgres://user:pw@localhost:5432/ac';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.databaseUrl).toBe('postgres://user:pw@localhost:5432/ac');
  });

  it('returns an empty databaseUrl when enabled but RUNFORGE_DATABASE_URL is unset', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.databaseUrl).toBe('');
  });

  // FIX (verdict fix_before_flag_on / .env.prod.example): env paths are resolved
  // AGAINST stateDir (which is itself `…/state`). The example files must use BARE
  // names — a leading `state/` would double-resolve to `…/state/state/…`, whose
  // parent is never created. These assertions pin both:
  //  (a) the CORRECT (bare) example value resolves directly under stateDir; and
  //  (b) the BUGGY `state/…` value demonstrably double-prefixes (regression guard
  //      so a future edit re-introducing `state/` in the examples is caught).
  // (The legacy sqlite db path is gone — the store lives in Postgres now — so the
  //  surviving stateDir-relative path is the protected dir.)
  it('bare example names resolve directly under stateDir (the fixed .env.example values)', () => {
    process.env.RUNFORGE_DECISION_PROTECTED_DIR = 'decision-protected/';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.protectedDir).toBe(join(stateDir, 'decision-protected'));
    // NOT double-prefixed.
    expect(cfg.protectedDir).not.toContain(join('state', 'state'));
  });

  it('a leading state/ prefix double-resolves to state/state/… (why bare names are required)', () => {
    // stateDir basename is `state` so a `state/…` value resolves to `state/state/…`.
    const stateLike = join(tmpdir(), 'state');
    process.env.RUNFORGE_DECISION_PROTECTED_DIR = 'state/decision-protected';
    const cfg = readDecisionIndexConfig(stateLike);
    expect(cfg.protectedDir).toBe(join(stateLike, 'state', 'decision-protected'));
    expect(cfg.protectedDir).toContain(join('state', 'state'));
  });

  it('defaults the protected dir to state/decision-protected (absolute)', () => {
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.protectedDir).toBe(join(stateDir, 'decision-protected'));
    expect(isAbsolute(cfg.protectedDir)).toBe(true);
  });

  // FIX 1 (flag-OFF blocker): a disabled daemon MUST NOT touch the filesystem.
  // The previous behavior unconditionally called loadOrGenerateKey(), which
  // wrote `state/decision-protected.key` (32 random bytes, mkdir+writeFile) on
  // first boot even when the flag was OFF — violating the "ZERO behavior change
  // when flag OFF" invariant and able to abort boot on a read-only/full stateDir.
  it('writes NOTHING to stateDir when the flag is unset (disabled => no key file, no I/O)', () => {
    const before = readdirSync(stateDir);
    const cfg = readDecisionIndexConfig(stateDir);

    expect(cfg.enabled).toBe(false);
    // No decision-protected.key file is created.
    expect(existsSync(join(stateDir, 'decision-protected.key'))).toBe(false);
    // stateDir is byte-for-byte untouched (nothing — sqlite or otherwise — created).
    expect(readdirSync(stateDir)).toEqual(before);
    // A placeholder/empty key is returned — never a freshly-generated one.
    expect(cfg.protectedKey).toBe('');
    // No Postgres URL is surfaced when disabled.
    expect(cfg.databaseUrl).toBe('');
  });

  it('writes NOTHING to stateDir when the flag is explicitly false', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'false';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.enabled).toBe(false);
    expect(existsSync(join(stateDir, 'decision-protected.key'))).toBe(false);
    expect(cfg.protectedKey).toBe('');
    expect(cfg.databaseUrl).toBe('');
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('generates a 32-byte base64 key and persists it when ENABLED and unset', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    const cfg = readDecisionIndexConfig(stateDir);
    const keyFile = join(stateDir, 'decision-protected.key');
    expect(existsSync(keyFile)).toBe(true);
    // key decodes to exactly 32 bytes (AES-256)
    expect(Buffer.from(cfg.protectedKey, 'base64')).toHaveLength(32);
    // persisted file matches the returned key
    expect(readFileSync(keyFile, 'utf-8').trim()).toBe(cfg.protectedKey);
  });

  it('reuses the persisted key across calls when ENABLED (does not regenerate)', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    const first = readDecisionIndexConfig(stateDir);
    const second = readDecisionIndexConfig(stateDir);
    expect(second.protectedKey).toBe(first.protectedKey);
  });

  it('uses an explicit RUNFORGE_DECISION_PROTECTED_KEY without persisting (when enabled)', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    const explicit = Buffer.alloc(32, 7).toString('base64');
    process.env.RUNFORGE_DECISION_PROTECTED_KEY = explicit;
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.protectedKey).toBe(explicit);
    // no key file written when an explicit key is supplied
    expect(existsSync(join(stateDir, 'decision-protected.key'))).toBe(false);
  });

  // Greenfield cutover preflight (spec §4): the store moved to Postgres. If a
  // legacy sqlite file still exists it may hold unanswered escalations the
  // greenfield migration would silently abandon — so refuse to boot the index
  // unless the operator acknowledges the cutover. The check is a pure
  // fs.existsSync — it NEVER opens the sqlite file (no better-sqlite3 native load).
  it('throws an actionable cutover error when ENABLED and a legacy sqlite store exists without ack', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    // A legacy store sitting at the default path that the operator never ack'd.
    writeFileSync(join(stateDir, 'decision-index.sqlite'), '');
    expect(() => readDecisionIndexConfig(stateDir)).toThrow(/legacy sqlite/i);
  });

  it('proceeds (no throw) when the cutover is acknowledged despite a legacy sqlite store', () => {
    process.env.RUNFORGE_DECISION_INDEX_ENABLED = 'true';
    process.env.RUNFORGE_DECISION_INDEX_CUTOVER_ACK = '1';
    writeFileSync(join(stateDir, 'decision-index.sqlite'), '');
    expect(() => readDecisionIndexConfig(stateDir)).not.toThrow();
  });

  it('does NOT run the cutover preflight when DISABLED (a legacy file is inert)', () => {
    // Flag OFF => zero filesystem I/O and no preflight, so a stray legacy file
    // never blocks a disabled daemon.
    writeFileSync(join(stateDir, 'decision-index.sqlite'), '');
    expect(() => readDecisionIndexConfig(stateDir)).not.toThrow();
    expect(readDecisionIndexConfig(stateDir).enabled).toBe(false);
  });
});
