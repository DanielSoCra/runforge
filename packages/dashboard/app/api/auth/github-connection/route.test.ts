import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

function mockSupabase(user: { id: string } | null, role?: string) {
  const single = vi.fn().mockResolvedValue({
    data: role ? { role } : null,
    error: role ? null : { code: 'PGRST116', message: 'not found' },
  });
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single,
    }),
  };
}

describe('GET /api/auth/github-connection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('AUTH_DISABLED', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('redirects to GitHub OAuth with correct params', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    (createClient as any).mockResolvedValueOnce(mockSupabase({ id: 'user-1' }, 'admin'));
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
    (createClient as any).mockResolvedValueOnce(mockSupabase(null));
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 if authenticated user is not an admin', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    (createClient as any).mockResolvedValueOnce(mockSupabase({ id: 'user-1' }, 'viewer'));
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);
    expect(res.status).toBe(403);
  });

  it('allows GitHub OAuth initiation when auth is disabled (#552)', async () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = mockSupabase(null);
    (createClient as any).mockResolvedValueOnce(supabase);
    const { GET } = await import('./route.js');
    const req = new Request('http://localhost:3000/api/auth/github-connection');
    const res = await GET(req as any);

    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location')).toContain('github.com/login/oauth/authorize');
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });
});
