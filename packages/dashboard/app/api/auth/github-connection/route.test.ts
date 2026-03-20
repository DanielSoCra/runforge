import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }),
  }),
}));

vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'test-client-id');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');

describe('GET /api/auth/github-connection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('redirects to GitHub OAuth with correct params', async () => {
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);

    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('scope=repo');
  });

  it('returns 401 if not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    (createClient as any).mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      from: vi.fn(),
    });
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });
});
