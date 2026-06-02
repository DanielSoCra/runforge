import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readDecisionIndexConfig } from './config.js';

/**
 * The decision-escalation env reader is the ONE place AUTO_CLAUDE_DECISION_* env
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
    delete process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED;
    delete process.env.AUTO_CLAUDE_DECISION_INDEX_PATH;
    delete process.env.AUTO_CLAUDE_DECISION_PROTECTED_KEY;
    delete process.env.AUTO_CLAUDE_DECISION_PROTECTED_DIR;
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
      process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED = v;
      expect(readDecisionIndexConfig(stateDir).enabled).toBe(true);
    }
    for (const v of ['false', '0', '', 'no', 'off']) {
      process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED = v;
      expect(readDecisionIndexConfig(stateDir).enabled).toBe(false);
    }
  });

  it('resolves db path to an absolute path under stateDir by default', () => {
    const cfg = readDecisionIndexConfig(stateDir);
    expect(isAbsolute(cfg.dbPath)).toBe(true);
    expect(cfg.dbPath).toBe(join(stateDir, 'decision-index.sqlite'));
  });

  it('honors an explicit relative db path resolved against stateDir', () => {
    process.env.AUTO_CLAUDE_DECISION_INDEX_PATH = 'sub/custom.sqlite';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.dbPath).toBe(join(stateDir, 'sub/custom.sqlite'));
  });

  it('honors an explicit absolute db path as-is', () => {
    const abs = join(stateDir, 'abs.sqlite');
    process.env.AUTO_CLAUDE_DECISION_INDEX_PATH = abs;
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.dbPath).toBe(abs);
  });

  // FIX (verdict fix_before_flag_on / .env.prod.example): env paths are resolved
  // AGAINST stateDir (which is itself `…/state`). The example files must use BARE
  // names — a leading `state/` would double-resolve to `…/state/state/…`, whose
  // parent openDb() never creates. These assertions pin both:
  //  (a) the CORRECT (bare) example value resolves directly under stateDir; and
  //  (b) the BUGGY `state/…` value demonstrably double-prefixes (regression guard
  //      so a future edit re-introducing `state/` in the examples is caught).
  it('bare example names resolve directly under stateDir (the fixed .env.example values)', () => {
    process.env.AUTO_CLAUDE_DECISION_INDEX_PATH = 'decision-index.sqlite';
    process.env.AUTO_CLAUDE_DECISION_PROTECTED_DIR = 'decision-protected/';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.dbPath).toBe(join(stateDir, 'decision-index.sqlite'));
    expect(cfg.protectedDir).toBe(join(stateDir, 'decision-protected'));
    // NOT double-prefixed.
    expect(cfg.dbPath).not.toContain(join('state', 'state'));
  });

  it('a leading state/ prefix double-resolves to state/state/… (why bare names are required)', () => {
    // stateDir basename is `state` so a `state/…` value resolves to `state/state/…`.
    const stateLike = join(tmpdir(), 'state');
    process.env.AUTO_CLAUDE_DECISION_INDEX_PATH = 'state/decision-index.sqlite';
    const cfg = readDecisionIndexConfig(stateLike);
    expect(cfg.dbPath).toBe(join(stateLike, 'state', 'decision-index.sqlite'));
    expect(cfg.dbPath).toContain(join('state', 'state'));
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
    // No sqlite file (or anything else) is created either.
    expect(existsSync(cfg.dbPath)).toBe(false);
    // stateDir is byte-for-byte untouched.
    expect(readdirSync(stateDir)).toEqual(before);
    // A placeholder/empty key is returned — never a freshly-generated one.
    expect(cfg.protectedKey).toBe('');
  });

  it('writes NOTHING to stateDir when the flag is explicitly false', () => {
    process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED = 'false';
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.enabled).toBe(false);
    expect(existsSync(join(stateDir, 'decision-protected.key'))).toBe(false);
    expect(cfg.protectedKey).toBe('');
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('generates a 32-byte base64 key and persists it when ENABLED and unset', () => {
    process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED = 'true';
    const cfg = readDecisionIndexConfig(stateDir);
    const keyFile = join(stateDir, 'decision-protected.key');
    expect(existsSync(keyFile)).toBe(true);
    // key decodes to exactly 32 bytes (AES-256)
    expect(Buffer.from(cfg.protectedKey, 'base64')).toHaveLength(32);
    // persisted file matches the returned key
    expect(readFileSync(keyFile, 'utf-8').trim()).toBe(cfg.protectedKey);
  });

  it('reuses the persisted key across calls when ENABLED (does not regenerate)', () => {
    process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED = 'true';
    const first = readDecisionIndexConfig(stateDir);
    const second = readDecisionIndexConfig(stateDir);
    expect(second.protectedKey).toBe(first.protectedKey);
  });

  it('uses an explicit AUTO_CLAUDE_DECISION_PROTECTED_KEY without persisting (when enabled)', () => {
    process.env.AUTO_CLAUDE_DECISION_INDEX_ENABLED = 'true';
    const explicit = Buffer.alloc(32, 7).toString('base64');
    process.env.AUTO_CLAUDE_DECISION_PROTECTED_KEY = explicit;
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.protectedKey).toBe(explicit);
    // no key file written when an explicit key is supplied
    expect(existsSync(join(stateDir, 'decision-protected.key'))).toBe(false);
  });
});
