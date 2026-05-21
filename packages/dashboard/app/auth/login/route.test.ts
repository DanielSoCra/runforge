import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getDashboardAuth: vi.fn(),
  handler: vi.fn(),
}));

vi.mock('@/lib/auth/better-auth', () => ({
  getDashboardAuth: mocks.getDashboardAuth,
}));

const makeRequest = (url: string): NextRequest =>
  new Request(url, { method: 'POST' }) as unknown as NextRequest;

describe('POST /auth/login', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getDashboardAuth.mockReset();
    mocks.handler.mockReset();
    mocks.getDashboardAuth.mockReturnValue({ handler: mocks.handler });
  });

  it('runs in the Node runtime', async () => {
    const { runtime } = await import('./route.js');

    expect(runtime).toBe('nodejs');
  });

  it('starts Better Auth GitHub OAuth and redirects to provider URL', async () => {
    const authResponse = new Response(
      JSON.stringify({ url: 'https://github.com/login/oauth/authorize' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'auto-claude.oauth_state=state; Path=/; HttpOnly',
        },
      },
    );
    mocks.handler.mockResolvedValue(authResponse);

    const { POST } = await import('./route.js');
    const response = await POST(makeRequest('http://localhost:3000/login'));

    expect([302, 303, 307, 308]).toContain(response.status);
    expect(response.headers.get('location')).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(response.headers.get('set-cookie')).toContain(
      'auto-claude.oauth_state=state',
    );
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    const authRequest = mocks.handler.mock.calls[0]?.[0] as Request;
    expect(authRequest.url).toBe(
      'http://localhost:3000/api/auth/sign-in/social',
    );
    await expect(authRequest.json()).resolves.toEqual({
      provider: 'github',
      callbackURL: '/',
      errorCallbackURL: '/login?error=oauth_failed',
    });
  });

  it('uses a Location header from Better Auth when present', async () => {
    mocks.handler.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { location: 'https://github.com/login/oauth/authorize' },
      }),
    );

    const { POST } = await import('./route.js');
    const response = await POST(makeRequest('http://localhost:3000/login'));

    expect(response.headers.get('location')).toBe(
      'https://github.com/login/oauth/authorize',
    );
  });

  it('redirects to oauth_failed when Better Auth rejects the login request', async () => {
    mocks.handler.mockResolvedValue(new Response('provider missing', { status: 404 }));

    const { POST } = await import('./route.js');
    const response = await POST(makeRequest('http://localhost:3000/login'));

    expect([302, 303, 307, 308]).toContain(response.status);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=oauth_failed',
    );
  });

  it('redirects to oauth_failed when Better Auth returns no provider URL', async () => {
    mocks.handler.mockResolvedValue(
      new Response(JSON.stringify({ redirect: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { POST } = await import('./route.js');
    const response = await POST(makeRequest('http://localhost:3000/login'));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=oauth_failed',
    );
  });
});
