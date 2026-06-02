import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readDecisionIndexConfig } from './config.js';

/**
 * The decision-escalation env reader is the ONE place AUTO_CLAUDE_DECISION_* env
 * vars are parsed. It resolves an absolute db path, defaults the protected dir,
 * and generates+persists a 32-byte base64 key when one is not supplied.
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

  it('defaults the protected dir to state/decision-protected (absolute)', () => {
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.protectedDir).toBe(join(stateDir, 'decision-protected'));
    expect(isAbsolute(cfg.protectedDir)).toBe(true);
  });

  it('generates a 32-byte base64 key and persists it when unset', () => {
    const cfg = readDecisionIndexConfig(stateDir);
    const keyFile = join(stateDir, 'decision-protected.key');
    expect(existsSync(keyFile)).toBe(true);
    // key decodes to exactly 32 bytes (AES-256)
    expect(Buffer.from(cfg.protectedKey, 'base64')).toHaveLength(32);
    // persisted file matches the returned key
    expect(readFileSync(keyFile, 'utf-8').trim()).toBe(cfg.protectedKey);
  });

  it('reuses the persisted key across calls (does not regenerate)', () => {
    const first = readDecisionIndexConfig(stateDir);
    const second = readDecisionIndexConfig(stateDir);
    expect(second.protectedKey).toBe(first.protectedKey);
  });

  it('uses an explicit AUTO_CLAUDE_DECISION_PROTECTED_KEY without persisting', () => {
    const explicit = Buffer.alloc(32, 7).toString('base64');
    process.env.AUTO_CLAUDE_DECISION_PROTECTED_KEY = explicit;
    const cfg = readDecisionIndexConfig(stateDir);
    expect(cfg.protectedKey).toBe(explicit);
    // no key file written when an explicit key is supplied
    expect(existsSync(join(stateDir, 'decision-protected.key'))).toBe(false);
  });
});
