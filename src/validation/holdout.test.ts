// src/validation/holdout.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHoldout } from './holdout.js';

vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../lib/process.js';

const mockRunCommand = runCommand as ReturnType<typeof vi.fn>;

describe('runHoldout', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('skips when no command is provided', async () => {
    const result = await runHoldout(undefined, 'refs/heads/main', '/workspace');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.skipped).toBe(true);
      expect(result.value.failures).toHaveLength(0);
    }
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('parses valid output with all scenarios passing', async () => {
    const output = JSON.stringify({
      scenarios: [
        { id: 'scenario-1', passed: true },
        { id: 'scenario-2', passed: true },
      ],
    });
    mockRunCommand.mockResolvedValue({ ok: true, value: output });

    const result = await runHoldout('./run-holdout.sh', 'refs/heads/feature', '/workspace');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.skipped).toBe(false);
      expect(result.value.failures).toHaveLength(0);
    }
  });

  it('returns failures for scenarios that did not pass', async () => {
    const output = JSON.stringify({
      scenarios: [
        { id: 'scenario-1', passed: true },
        { id: 'scenario-2', passed: false },
        { id: 'scenario-3', passed: false },
      ],
    });
    mockRunCommand.mockResolvedValue({ ok: true, value: output });

    const result = await runHoldout('./run-holdout.sh', 'refs/heads/feature', '/workspace');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.skipped).toBe(false);
      expect(result.value.failures).toHaveLength(2);
      expect(result.value.failures[0]?.id).toBe('scenario-2');
      expect(result.value.failures[1]?.id).toBe('scenario-3');
    }
  });

  it('returns err when command output is invalid JSON', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: 'not valid json' });

    const result = await runHoldout('./run-holdout.sh', 'refs/heads/feature', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Failed to parse holdout output as JSON');
    }
  });

  it('returns err when output JSON is missing scenarios array', async () => {
    const output = JSON.stringify({ results: [] });
    mockRunCommand.mockResolvedValue({ ok: true, value: output });

    const result = await runHoldout('./run-holdout.sh', 'refs/heads/feature', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Holdout output missing scenarios array');
    }
  });

  it('returns err when command fails', async () => {
    mockRunCommand.mockResolvedValue({ ok: false, error: new Error('sh failed (1): command not found') });

    const result = await runHoldout('./run-holdout.sh', 'refs/heads/feature', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Holdout runner failed');
      expect(result.error.message).toContain('command not found');
    }
  });

  it('passes BRANCH_REF and cwd to runCommand', async () => {
    const output = JSON.stringify({ scenarios: [] });
    mockRunCommand.mockResolvedValue({ ok: true, value: output });

    await runHoldout('./run-holdout.sh', 'refs/heads/my-feature', '/my/project');

    expect(mockRunCommand).toHaveBeenCalledWith(
      'sh',
      ['-c', './run-holdout.sh'],
      {
        cwd: '/my/project',
        env: { BRANCH_REF: 'refs/heads/my-feature' },
        timeoutMs: 300_000,
      },
    );
  });
});
