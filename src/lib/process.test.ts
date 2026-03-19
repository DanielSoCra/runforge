// src/lib/process.test.ts
import { describe, it, expect } from 'vitest';
import { runCommand, buildSafeEnv } from './process.js';

describe('runCommand', () => {
  it('runs a command and captures stdout', async () => {
    const result = await runCommand('echo', ['hello']);
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('returns err on non-zero exit', async () => {
    const result = await runCommand('false', []);
    expect(result.ok).toBe(false);
  });

  it('times out long-running commands', async () => {
    const result = await runCommand('sleep', ['10'], { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('timed out');
  });

  it('uses safe env by default (no secrets leak)', async () => {
    // Set a fake secret in current process env
    process.env['SECRET_KEY'] = 'super-secret';
    const result = await runCommand('env', []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toContain('SECRET_KEY');
      expect(result.value).not.toContain('super-secret');
    }
    delete process.env['SECRET_KEY'];
  });

  it('allows passing custom env vars', async () => {
    const result = await runCommand('env', [], { env: { MY_VAR: 'hello' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('MY_VAR=hello');
  });

  it('accepts a cwd option', async () => {
    const result = await runCommand('pwd', [], { cwd: '/tmp' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('/tmp');
  });
});

describe('buildSafeEnv', () => {
  it('includes PATH and HOME', () => {
    const env = buildSafeEnv();
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
  });

  it('includes TERM as dumb and LANG', () => {
    const env = buildSafeEnv();
    expect(env.TERM).toBe('dumb');
    expect(env.LANG).toBeDefined();
  });

  it('merges extra vars', () => {
    const env = buildSafeEnv({ FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });

  it('does not include random process.env vars', () => {
    process.env['RANDOM_SECRET'] = 'value';
    const env = buildSafeEnv();
    expect(env.RANDOM_SECRET).toBeUndefined();
    delete process.env['RANDOM_SECRET'];
  });
});
