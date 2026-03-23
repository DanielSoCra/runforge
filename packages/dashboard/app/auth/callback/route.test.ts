import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockSupabase = {
  auth: {
    exchangeCodeForSession: vi.fn(),
    signOut: vi.fn().mockResolvedValue({}),
  },
  rpc: vi.fn(),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabase),
}));

vi.mock('@/lib/auth', () => ({
  getOrigin: () => 'http://localhost:3000',
}));

const makeRequest = (url: string): NextRequest =>
  new Request(url) as unknown as NextRequest;

describe('GET /auth/callback', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSupabase.auth.exchangeCodeForSession.mockReset();
    mockSupabase.auth.signOut.mockReset().mockResolvedValue({});
    mockSupabase.rpc.mockReset();
  });

  it('redirects to /login?error=no_code when code param is missing', async () => {
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest('http://localhost:3000/auth/callback'));
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login?error=no_code');
  });

  it('redirects to /login?error=auth_failed when exchangeCodeForSession returns error', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: new Error('invalid code'),
    });
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest('http://localhost:3000/auth/callback?code=bad'));
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login?error=auth_failed');
  });

  it('redirects to /login?error=auth_failed when user is null without error', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: null,
    });
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest('http://localhost:3000/auth/callback?code=bad'));
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login?error=auth_failed');
  });

  it('calls bootstrap_user_access RPC with user id and provider handle', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'u-1', user_metadata: { user_name: 'dan' } } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: 'admin' });
    const { GET } = await import('./route.js');
    await GET(makeRequest('http://localhost:3000/auth/callback?code=valid'));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('bootstrap_user_access', {
      p_user_id: 'u-1',
      p_provider_handle: 'dan',
    });
  });

  it('signs out and redirects to access_denied when bootstrap returns denied', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'u-2', user_metadata: { user_name: 'attacker' } } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: 'denied' });
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest('http://localhost:3000/auth/callback?code=valid'));
    expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login?error=access_denied');
  });

  it('signs out and redirects to access_denied when RPC errors (#350 regression)', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'u-rpc', user_metadata: { user_name: 'user' } } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: null, error: new Error('rpc failed') });
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest('http://localhost:3000/auth/callback?code=valid'));
    expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login?error=access_denied');
  });

  it('redirects to / on successful bootstrap (non-denied)', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'u-3', user_metadata: { user_name: 'member' } } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: 'viewer' });
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest('http://localhost:3000/auth/callback?code=valid'));
    expect(mockSupabase.auth.signOut).not.toHaveBeenCalled();
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('http://localhost:3000/');
  });

  it('uses email as fallback when user_name is not in metadata', async () => {
    mockSupabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'u-4', email: 'test@example.com', user_metadata: {} } },
      error: null,
    });
    mockSupabase.rpc.mockResolvedValue({ data: 'admin' });
    const { GET } = await import('./route.js');
    await GET(makeRequest('http://localhost:3000/auth/callback?code=valid'));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('bootstrap_user_access', {
      p_user_id: 'u-4',
      p_provider_handle: 'test@example.com',
    });
  });
});
