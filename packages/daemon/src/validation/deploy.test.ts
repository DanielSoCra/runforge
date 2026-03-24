// src/validation/deploy.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runDeploy,
  validateHealthCheckUrl,
  validateHealthCheckResolvedIP,
  isBlockedHealthCheckIP,
} from './deploy.js';

vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]),
}));

import { lookup } from 'node:dns/promises';
const mockLookup = vi.mocked(lookup);

import { runCommand } from '../lib/process.js';
const mockRunCommand = vi.mocked(runCommand);

describe('validateHealthCheckUrl', () => {
  it('allows localhost URLs', () => {
    expect(validateHealthCheckUrl('http://localhost:3000/health')).toBeNull();
  });

  it('allows 127.0.0.1 (loopback)', () => {
    expect(validateHealthCheckUrl('http://127.0.0.1:3000/health')).toBeNull();
  });

  it('allows public IPs', () => {
    expect(validateHealthCheckUrl('https://203.0.113.50/health')).toBeNull();
  });

  it('blocks cloud metadata endpoint (169.254.169.254)', () => {
    const result = validateHealthCheckUrl(
      'http://169.254.169.254/latest/meta-data/',
    );
    expect(result).toContain('blocked internal address');
  });

  it('blocks link-local addresses', () => {
    expect(
      validateHealthCheckUrl('http://169.254.1.1/health'),
    ).toContain('blocked internal address');
  });

  it('blocks RFC 1918 Class A (10.x.x.x)', () => {
    expect(
      validateHealthCheckUrl('http://10.0.0.1/health'),
    ).toContain('blocked internal address');
  });

  it('blocks RFC 1918 Class B (172.16-31.x.x)', () => {
    expect(
      validateHealthCheckUrl('http://172.16.0.1/health'),
    ).toContain('blocked internal address');
  });

  it('blocks RFC 1918 Class C (192.168.x.x)', () => {
    expect(
      validateHealthCheckUrl('http://192.168.1.1/health'),
    ).toContain('blocked internal address');
  });

  it('blocks CGNAT range (100.64.x.x)', () => {
    expect(
      validateHealthCheckUrl('http://100.64.0.1/health'),
    ).toContain('blocked internal address');
  });

  it('blocks 0.0.0.0 (unspecified)', () => {
    expect(
      validateHealthCheckUrl('http://0.0.0.0:3000/health'),
    ).toContain('blocked internal address');
  });

  it('rejects non-http/https schemes', () => {
    expect(validateHealthCheckUrl('ftp://localhost/health')).toContain(
      'not allowed',
    );
  });

  it('rejects invalid URLs', () => {
    expect(validateHealthCheckUrl('not-a-url')).toBe('invalid URL');
  });
});

describe('isBlockedHealthCheckIP', () => {
  it('allows loopback 127.0.0.1', () => {
    expect(isBlockedHealthCheckIP('127.0.0.1')).toBe(false);
  });

  it('allows ::1', () => {
    expect(isBlockedHealthCheckIP('::1')).toBe(false);
  });

  it('blocks cloud metadata 169.254.169.254', () => {
    expect(isBlockedHealthCheckIP('169.254.169.254')).toBe(true);
  });

  it('blocks CGNAT 100.64.0.1', () => {
    expect(isBlockedHealthCheckIP('100.64.0.1')).toBe(true);
  });

  it('blocks 0.0.0.0', () => {
    expect(isBlockedHealthCheckIP('0.0.0.0')).toBe(true);
  });

  it('blocks :: (IPv6 unspecified)', () => {
    expect(isBlockedHealthCheckIP('::')).toBe(true);
  });

  it('blocks IPv6-mapped private IP (::ffff:10.0.0.1)', () => {
    expect(isBlockedHealthCheckIP('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows IPv6-mapped loopback (::ffff:127.0.0.1)', () => {
    expect(isBlockedHealthCheckIP('::ffff:127.0.0.1')).toBe(false);
  });

  it('blocks IPv6-mapped cloud metadata (::ffff:169.254.169.254)', () => {
    expect(isBlockedHealthCheckIP('::ffff:169.254.169.254')).toBe(true);
  });
});

describe('validateHealthCheckResolvedIP', () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it('allows loopback resolved IPs', async () => {
    mockLookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ] as never);
    const result = await validateHealthCheckResolvedIP(
      'http://myapp.local:3000/health',
    );
    expect(result).toBeNull();
  });

  it('blocks DNS resolving to cloud metadata IP', async () => {
    mockLookup.mockResolvedValue([
      { address: '169.254.169.254', family: 4 },
    ] as never);
    const result = await validateHealthCheckResolvedIP(
      'http://evil.example.com/health',
    );
    expect(result).toContain('blocked internal address');
  });

  it('blocks DNS resolving to private network', async () => {
    mockLookup.mockResolvedValue([
      { address: '10.0.0.5', family: 4 },
    ] as never);
    const result = await validateHealthCheckResolvedIP(
      'http://internal.example.com/health',
    );
    expect(result).toContain('blocked internal address');
  });

  it('allows IP literal loopback without DNS', async () => {
    const result = await validateHealthCheckResolvedIP(
      'http://127.0.0.1:3000/health',
    );
    expect(result).toBeNull();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('blocks IP literal cloud metadata without DNS', async () => {
    const result = await validateHealthCheckResolvedIP(
      'http://169.254.169.254/latest/meta-data/',
    );
    expect(result).toContain('blocked internal address');
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('runDeploy', () => {
  beforeEach(() => {
    mockRunCommand.mockClear();
    mockLookup.mockClear();
    vi.stubGlobal('fetch', vi.fn());
    mockLookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ] as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('rejects health check URL targeting cloud metadata (SSRF)', async () => {
    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://169.254.169.254/latest/meta-data/',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 1,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('blocked internal address');
    }
    // Must NOT have attempted the deploy command
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects health check URL targeting private network', async () => {
    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://10.0.0.5:8080/health',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 1,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('blocked internal address');
    }
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('rejects health check URL when DNS resolves to private IP (rebinding)', async () => {
    mockLookup.mockResolvedValue([
      { address: '169.254.169.254', family: 4 },
    ] as never);

    const result = await runDeploy({
      deployCommand: 'deploy.sh',
      healthCheckUrl: 'http://evil.example.com/health',
      healthCheckIntervalMs: 100,
      deployTimeoutMs: 1000,
      maxAttempts: 1,
      cwd: '/workspace',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('blocked internal address');
    }
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('returns failed when deploy command fails after all retries', async () => {
    mockRunCommand.mockResolvedValue({
      ok: false,
      error: new Error('deploy crashed'),
    });

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
    vi.mocked(fetch).mockImplementation(async () => {
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
      'sh',
      ['-c', 'deploy.sh'],
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
