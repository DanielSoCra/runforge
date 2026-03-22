// src/validation/deploy.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDeploy } from './deploy.js';

vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../lib/process.js';
const mockRunCommand = vi.mocked(runCommand);

describe('runDeploy', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns healthy when deploy succeeds and health check passes', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: 'deployed' });
    vi.mocked(fetch).mockResolvedValue(new Response('ok', { status: 200 }));

    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://localhost:3000/health',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 2,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('healthy');
    }
  });

  it('returns failed when deploy command fails after all retries', async () => {
    mockRunCommand.mockResolvedValue({ ok: false, error: new Error('deploy crashed') });

    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://localhost:3000/health',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 2,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('failed');
    }
    expect(mockRunCommand).toHaveBeenCalledTimes(2);
  });

  it('returns timeout when health check never passes', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: 'deployed' });
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'));

    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://localhost:3000/health',
      healthCheckIntervalMs: 50,
      deployTimeoutMs: 200,
      maxAttempts: 1,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('timeout');
    }
  });

  it('retries deploy on health check timeout', async () => {
    let deployCount = 0;
    mockRunCommand.mockImplementation(async () => {
      deployCount++;
      return { ok: true as const, value: 'deployed' };
    });

    // First deploy: health check fails. Second deploy: health check passes.
    let fetchCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      fetchCount++;
      if (deployCount <= 1) throw new Error('connection refused');
      return new Response('ok', { status: 200 });
    });

    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://localhost:3000/health',
      healthCheckIntervalMs: 50,
      deployTimeoutMs: 200,
      maxAttempts: 2,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('healthy');
    }
    expect(deployCount).toBe(2);
  });

  it('passes cwd to deploy command', async () => {
    mockRunCommand.mockResolvedValue({ ok: true, value: 'deployed' });
    vi.mocked(fetch).mockResolvedValue(new Response('ok', { status: 200 }));

    await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://localhost:3000/health',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 1,
      cwd: '/my/workspace',
    });

    expect(mockRunCommand).toHaveBeenCalledWith(
      'sh', ['-c', 'deploy.sh'],
      expect.objectContaining({ cwd: '/my/workspace' }),
    );
  });

  it('validates deploy command for shell injection', async () => {
    const result = await runDeploy({
      deployCommand: 'deploy.sh; rm -rf /',
      healthCheckUrl: 'http://localhost:3000/health',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 1,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(false);
  });
});
