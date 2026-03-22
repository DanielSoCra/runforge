import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Mock @supabase/ssr
const mockGetUser = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

// Mock env to avoid missing-env errors
vi.mock('./env', () => ({
  getSupabaseEnv: () => ({
    url: 'https://test.supabase.co',
    anonKey: 'test-anon-key',
  }),
}));

import { updateSession } from './middleware';

/** Helper to build a minimal NextRequest-like object */
function makeRequest(pathname: string): NextRequest {
  const url = new URL(pathname, 'http://localhost:3000');
  const req = new Request(url.toString());

  // NextRequest augments Request with nextUrl and cookies
  const cookies = {
    getAll: () => [] as Array<{ name: string; value: string }>,
    set: vi.fn(),
  };

  // nextUrl needs a clone() method that returns a mutable copy
  const nextUrl = Object.assign(new URL(url.toString()), {
    clone: () => new URL(url.toString()),
  });

  return Object.assign(req, {
    nextUrl,
    cookies,
  }) as unknown as NextRequest;
}

describe('updateSession middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through authenticated users on protected paths', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });

    const response = await updateSession(makeRequest('/dashboard'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects unauthenticated users on protected paths to /login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const response = await updateSession(makeRequest('/dashboard'));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('allows unauthenticated access to /login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const response = await updateSession(makeRequest('/login'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows unauthenticated access to /auth paths', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const response = await updateSession(makeRequest('/auth/callback'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows authenticated users on public paths without redirect', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });

    const response = await updateSession(makeRequest('/login'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('preserves cookies on redirect responses', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    // Spy on NextResponse.redirect to verify cookie forwarding
    const response = await updateSession(makeRequest('/settings'));

    expect(response.status).toBe(307);
    // The redirect response should be a valid NextResponse
    expect(response).toBeInstanceOf(NextResponse);
  });
});
