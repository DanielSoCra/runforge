// src/session-runtime/timeout-hook-script.test.ts
import { describe, it, expect } from 'vitest';
import { generateTimeoutHookScript } from './timeout-hook-script.js';

describe('generateTimeoutHookScript', () => {
  it('returns a valid Node.js script string', () => {
    const script = generateTimeoutHookScript();
    expect(script).toContain('#!/usr/bin/env node');
    expect(script).toContain('SESSION_START_TIME');
    expect(script).toContain('SESSION_TIMEOUT_MS');
  });

  it('uses os.tmpdir() for marker path instead of process.env.TMPDIR fallback (#142)', () => {
    const script = generateTimeoutHookScript();
    // Must use os.tmpdir() for consistency with cli.ts setupHooks which also uses os.tmpdir()
    expect(script).toContain("require('os').tmpdir()");
    // Must NOT use the fragile process.env.TMPDIR || '/tmp' pattern
    expect(script).not.toContain("process.env.TMPDIR || '/tmp'");
  });

  it('includes one-shot marker file logic', () => {
    const script = generateTimeoutHookScript();
    expect(script).toContain('timeout-warned-');
    expect(script).toContain('.marker');
    expect(script).toContain('existsSync');
  });

  it('exits 2 with warning on first threshold crossing', () => {
    const script = generateTimeoutHookScript();
    expect(script).toContain('process.exit(2)');
  });

  it('exits 0 when no start time is set', () => {
    const script = generateTimeoutHookScript();
    // Early exit when SESSION_START_TIME is missing
    expect(script).toContain('process.exit(0)');
  });
});
