import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = {
  auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  }),
  rpc: vi.fn().mockResolvedValue({ data: 'conn-id', error: null }),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabase),
}));

vi.mock('@/lib/auth', () => ({
  getOrigin: vi.fn().mockReturnValue('http://localhost:3000'),
}));

vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'cid');
vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'csec');
vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');

// Mock fetch for GitHub API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GET /api/auth/github-connection/callback', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    mockSupabase.rpc.mockResolvedValue({ data: 'conn-id', error: null });
  });

  it('returns 302/307 redirect on CSRF state mismatch', async () => {
    const { GET } = await import('./route.js');
    const req = new Request(
      'http://localhost:3000/api/auth/github-connection/callback?code=abc&state=wrong'
    );
    // Cookie has different state than query param
    Object.defineProperty(req, 'cookies', {
      value: { get: () => ({ value: 'correct-state' }) },
    });
    const res = await GET(req as any);
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('error=invalid_state');
  });

  it('exchanges code and stores connection on valid state', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'ghp_test', scope: 'repo,read:org' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'dan', name: 'Dan', avatar_url: 'https://a.b/c.png', id: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 10, login: 'acme', name: 'Acme Corp', avatar_url: 'https://x.y/z.png' }] });

    const { GET } = await import('./route.js');
    const req = new Request(
      'http://localhost:3000/api/auth/github-connection/callback?code=valid-code&state=match'
    );
    Object.defineProperty(req, 'cookies', {
      value: { get: () => ({ value: 'match' }) },
    });
    const res = await GET(req as any);
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('store_github_connection', expect.objectContaining({
      p_github_login: 'dan',
    }));
  });

  it('redirects with error=orgs_failed when github_orgs upsert fails', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'ghp_test', scope: 'repo,read:org' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'dan', name: 'Dan', avatar_url: 'https://a.b/c.png', id: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 10, login: 'acme', name: 'Acme Corp', avatar_url: 'https://x.y/z.png' }] });

    // First from() call is team_members (normal), second is github_orgs (error)
    mockSupabase.from
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
      })
      .mockReturnValueOnce({
        upsert: vi.fn().mockResolvedValue({ error: { message: 'constraint violation' } }),
      });

    const { GET } = await import('./route.js');
    const req = new Request(
      'http://localhost:3000/api/auth/github-connection/callback?code=valid-code&state=match'
    );
    Object.defineProperty(req, 'cookies', {
      value: { get: () => ({ value: 'match' }) },
    });
    const res = await GET(req as any);
    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('error=orgs_failed');
  });
});
