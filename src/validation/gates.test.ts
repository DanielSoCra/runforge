// src/validation/gates.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGate1 } from './gates.js';

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
      'vitest',
      ['run'],
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
});
