import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveLocalAuthBypass: vi.fn(),
}));

vi.mock('../auth/src/local-bypass', () => ({
  resolveLocalAuthBypass: mocks.resolveLocalAuthBypass,
}));

function makeRequest(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe('proxy', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveLocalAuthBypass.mockReset();
    mocks.resolveLocalAuthBypass.mockReturnValue({
      enabled: false,
      reason: 'not-requested',
    });
  });

  describe('proxy()', () => {
    it('allows public paths without a session cookie', async () => {
      const { proxy } = await import('./proxy');

      await expect(proxy(makeRequest('/login'))).resolves.toMatchObject({
        status: 200,
      });
      await expect(proxy(makeRequest('/auth/login'))).resolves.toMatchObject({
        status: 200,
      });
      await expect(proxy(makeRequest('/api/daemon/status'))).resolves.toMatchObject({
        status: 200,
      });
    });

    it('allows protected paths with a Better Auth session cookie', async () => {
      const { proxy } = await import('./proxy');

      const response = await proxy(
        makeRequest('/repos', 'auto-claude.session_token=signed-token'),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    });

    it('allows protected paths with a secure Better Auth session cookie', async () => {
      const { proxy } = await import('./proxy');

      const response = await proxy(
        makeRequest('/repos', '__Secure-auto-claude.session_token=signed-token'),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    });

    it('redirects protected paths without a Better Auth session cookie', async () => {
      const { proxy } = await import('./proxy');

      const response = await proxy(makeRequest('/repos'));

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/login');
    });

    it('allows all paths when local auth bypass is enabled', async () => {
      mocks.resolveLocalAuthBypass.mockReturnValue({ enabled: true });
      const { proxy } = await import('./proxy');

      const response = await proxy(makeRequest('/repos'));

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    });
  });

  describe('config.matcher', () => {
    let matcherRegex: RegExp;

    beforeEach(async () => {
      const { config } = await import('./proxy');
      matcherRegex = new RegExp('^' + config.matcher[0] + '$');
    });

    it('matches dashboard routes', () => {
      expect('/').toMatch(matcherRegex);
      expect('/repos').toMatch(matcherRegex);
      expect('/runs').toMatch(matcherRegex);
      expect('/cost').toMatch(matcherRegex);
      expect('/settings').toMatch(matcherRegex);
      expect('/team').toMatch(matcherRegex);
      expect('/login').toMatch(matcherRegex);
      expect('/auth/login').toMatch(matcherRegex);
    });

    it('matches API routes', () => {
      expect('/api/daemon/pause').toMatch(matcherRegex);
      expect('/api/daemon/status').toMatch(matcherRegex);
    });

    it('excludes static assets by extension', () => {
      expect('/favicon.ico').not.toMatch(matcherRegex);
      expect('/logo.svg').not.toMatch(matcherRegex);
      expect('/hero.png').not.toMatch(matcherRegex);
      expect('/photo.jpg').not.toMatch(matcherRegex);
      expect('/photo.jpeg').not.toMatch(matcherRegex);
      expect('/anim.gif').not.toMatch(matcherRegex);
      expect('/bg.webp').not.toMatch(matcherRegex);
      expect('/images/hero.png').not.toMatch(matcherRegex);
    });

    it('only excludes favicon.ico by name, not all .ico files', () => {
      expect('/assets/app.ico').toMatch(matcherRegex);
    });

    it('excludes Next.js internal paths', () => {
      expect('/_next/static/chunks/main.js').not.toMatch(matcherRegex);
      expect('/_next/image?url=foo').not.toMatch(matcherRegex);
    });
  });
});
