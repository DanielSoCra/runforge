import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getOrigin } from './auth';

describe('getOrigin', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns SITE_URL when set', () => {
    vi.stubEnv('SITE_URL', 'https://dashboard.example.com');
    expect(getOrigin()).toBe('https://dashboard.example.com');
  });

  it('strips trailing slash from SITE_URL', () => {
    vi.stubEnv('SITE_URL', 'https://dashboard.example.com/');
    expect(getOrigin()).toBe('https://dashboard.example.com');
  });

  it('throws in production when SITE_URL is not set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.SITE_URL;
    expect(() => getOrigin()).toThrow('SITE_URL environment variable is required in production');
  });

  it('ignores X-Forwarded-Host header even when provided (regression: SEC-4)', () => {
    vi.stubEnv('SITE_URL', 'https://dashboard.example.com');
    const maliciousRequest = new Request('http://internal:3000/auth/login', {
      headers: {
        'x-forwarded-host': 'evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    });
    // Must return SITE_URL, never the attacker-controlled header
    expect(getOrigin(maliciousRequest)).toBe('https://dashboard.example.com');
  });

  it('uses request.url origin in development when SITE_URL is not set', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.SITE_URL;
    const request = new Request('http://localhost:3000/auth/callback');
    expect(getOrigin(request)).toBe('http://localhost:3000');
  });

  it('never uses X-Forwarded-Host even in development (regression: SEC-4)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.SITE_URL;
    const maliciousRequest = new Request('http://localhost:3000/auth/login', {
      headers: {
        'x-forwarded-host': 'evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    });
    // Must return localhost, never the attacker-controlled header
    expect(getOrigin(maliciousRequest)).toBe('http://localhost:3000');
  });

  it('falls back to localhost:3000 in development with no request', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.SITE_URL;
    expect(getOrigin()).toBe('http://localhost:3000');
  });
});
