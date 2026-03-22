// src/validation/post-deploy-test.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runPostDeployTests, truncateFailureOutput } from './post-deploy-test.js';

vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../lib/process.js';
const mockRunCommand = vi.mocked(runCommand);

describe('truncateFailureOutput', () => {
  it('returns full output when shorter than maxLines', () => {
    const output = 'line1\nline2\nline3';
    expect(truncateFailureOutput(output, 50)).toBe(output);
  });

  it('truncates around failure marker scanning backwards', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines[80] = 'FAIL src/foo.test.ts';
    const output = lines.join('\n');
    const result = truncateFailureOutput(output, 10);
    expect(result).toContain('FAIL src/foo.test.ts');
    expect(result.split('\n').length).toBeLessThanOrEqual(10);
  });

  it('scans backwards for Error marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines[90] = 'Error: something broke';
    const output = lines.join('\n');
    const result = truncateFailureOutput(output, 10);
    expect(result).toContain('Error: something broke');
  });

  it('takes last N lines when no failure marker found', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const output = lines.join('\n');
    const result = truncateFailureOutput(output, 10);
    expect(result.split('\n').length).toBe(10);
    expect(result).toContain('line 99');
  });
});

describe('runPostDeployTests', () => {
  it('returns all-passed when all commands succeed', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: 'all tests passed' });

    const result = await runPostDeployTests({
      testCommands: ['vitest run', 'playwright test'],
      maxFixAttempts: 3,
      failureExcerptLines: 50,
      cwd: '/workspace',
    });

    expect(result.passed).toBe(true);
    expect(result.fixAttempts).toBe(0);
  });

  it('returns failed with truncated output on failure without fixHandler', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ ok: true, value: 'passed' })
      .mockResolvedValueOnce({ ok: false, error: new Error('FAIL test1\nsome output') });

    const result = await runPostDeployTests({
      testCommands: ['vitest run', 'playwright test'],
      maxFixAttempts: 3,
      failureExcerptLines: 50,
      cwd: '/workspace',
    });

    expect(result.passed).toBe(false);
    expect(result.failedCommand).toBe('playwright test');
  });

  it('runs fix cycle on failure when fixHandler provided', async () => {
    let callCount = 0;
    mockRunCommand.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return { ok: false as const, error: new Error('FAIL test error') };
      }
      return { ok: true as const, value: 'passed' };
    });
    const fixHandler = vi.fn().mockResolvedValue(true);

    const result = await runPostDeployTests({
      testCommands: ['vitest run'],
      maxFixAttempts: 3,
      failureExcerptLines: 50,
      cwd: '/workspace',
      fixHandler,
    });

    expect(result.passed).toBe(true);
    expect(result.fixAttempts).toBe(2);
    expect(fixHandler).toHaveBeenCalledTimes(2);
  });

  it('escalates after max fix attempts', async () => {
    mockRunCommand.mockResolvedValue({ ok: false, error: new Error('FAIL persistent') });
    const fixHandler = vi.fn().mockResolvedValue(true);

    const result = await runPostDeployTests({
      testCommands: ['vitest run'],
      maxFixAttempts: 2,
      failureExcerptLines: 50,
      cwd: '/workspace',
      fixHandler,
    });

    expect(result.passed).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.fixAttempts).toBe(2);
  });

  it('passes truncated failure output to fixHandler', async () => {
    const longError = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\nFAIL test error';
    mockRunCommand
      .mockResolvedValueOnce({ ok: false, error: new Error(longError) })
      .mockResolvedValue({ ok: true, value: 'passed' });
    const fixHandler = vi.fn().mockResolvedValue(true);

    await runPostDeployTests({
      testCommands: ['vitest run'],
      maxFixAttempts: 3,
      failureExcerptLines: 10,
      cwd: '/workspace',
      fixHandler,
    });

    const passedOutput = fixHandler.mock.calls[0]![0] as string;
    expect(passedOutput.split('\n').length).toBeLessThanOrEqual(10);
    expect(passedOutput).toContain('FAIL test error');
  });

  it('validates test commands for shell injection', async () => {
    const result = await runPostDeployTests({
      testCommands: ['vitest run; rm -rf /'],
      maxFixAttempts: 1,
      failureExcerptLines: 50,
      cwd: '/workspace',
    });

    expect(result.passed).toBe(false);
    expect(result.error).toContain('disallowed');
  });
});
