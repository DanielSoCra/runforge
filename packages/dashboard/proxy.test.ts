import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock the updateSession dependency
const mockUpdateSession = vi.fn();
vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

describe('proxy', () => {
  beforeEach(() => {
    mockUpdateSession.mockReset();
  });

  describe('proxy()', () => {
    it('calls updateSession with the request and returns its response', async () => {
      const fakeResponse = NextResponse.next();
      mockUpdateSession.mockResolvedValue(fakeResponse);

      const { proxy } = await import('./proxy');
      const request = new NextRequest('http://localhost:3000/dashboard');

      const result = await proxy(request);

      expect(mockUpdateSession).toHaveBeenCalledWith(request);
      expect(result).toBe(fakeResponse);
    });

    it('returns redirect response when updateSession redirects', async () => {
      const redirectResponse = NextResponse.redirect(new URL('http://localhost:3000/login'));
      mockUpdateSession.mockResolvedValue(redirectResponse);

      const { proxy } = await import('./proxy');
      const request = new NextRequest('http://localhost:3000/repos');

      const result = await proxy(request);

      expect(result).toBe(redirectResponse);
      expect(result.status).toBe(307);
    });

    it('propagates errors from updateSession', async () => {
      mockUpdateSession.mockRejectedValue(new Error('Supabase unreachable'));

      const { proxy } = await import('./proxy');
      const request = new NextRequest('http://localhost:3000/');

      await expect(proxy(request)).rejects.toThrow('Supabase unreachable');
    });
  });

  describe('config.matcher', () => {
    let matcherRegex: RegExp;

    beforeEach(async () => {
      const { config } = await import('./proxy');
      // Next.js applies matcher as a full-path match — anchor the regex.
      // This construction is valid only because the matcher uses a raw regex
      // pattern, not Next.js path parameter syntax (e.g. /:path*).
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
      expect('/auth/callback').toMatch(matcherRegex);
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
      // Nested static asset paths are also excluded
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
