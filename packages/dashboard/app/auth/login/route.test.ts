import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

const mockSupabase = vi.hoisted(() => ({
  auth: {
    signInWithOAuth: vi.fn(),
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabase),
}));

vi.mock('@/lib/auth', () => ({
  getOrigin: () => 'http://localhost:3000',
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

const makeRequest = (url: string): NextRequest =>
  new Request(url) as unknown as NextRequest;

describe('POST /auth/login', () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    mockSupabase.auth.signInWithOAuth.mockReset();
  });

  it('starts GitHub OAuth and redirects to provider URL', async () => {
    mockSupabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://github.com/login/oauth/authorize' },
      error: null,
    });

    const { POST } = await import('./route.js');

    await expect(
      POST(makeRequest('http://localhost:3000/login')),
    ).rejects.toThrow(
      'NEXT_REDIRECT:https://github.com/login/oauth/authorize',
    );
    expect(mockSupabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: {
        redirectTo: 'http://localhost:3000/auth/callback',
      },
    });
  });

  it('redirects to oauth_failed when Supabase returns an OAuth error', async () => {
    mockSupabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: new Error('provider rejected request'),
    });

    const { POST } = await import('./route.js');

    await expect(
      POST(makeRequest('http://localhost:3000/login')),
    ).rejects.toThrow('NEXT_REDIRECT:/login?error=oauth_failed');
  });

  it('redirects to oauth_failed when Supabase returns no provider URL', async () => {
    mockSupabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: '' },
      error: null,
    });

    const { POST } = await import('./route.js');

    await expect(
      POST(makeRequest('http://localhost:3000/login')),
    ).rejects.toThrow('NEXT_REDIRECT:/login?error=oauth_failed');
  });
});
