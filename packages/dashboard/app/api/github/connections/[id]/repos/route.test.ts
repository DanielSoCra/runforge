import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

// ---------- mock factories ----------

function mockSupabaseAdmin() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }),
  };
}

function mockSupabaseUnauthenticated() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(),
  };
}

function mockSupabaseNonAdmin() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-2' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'viewer' }, error: null }),
    }),
  };
}

// Supabase client that also supports the github_connections query for personal-vs-org branching
function mockSupabaseAdminWithConnection(githubLogin: string) {
  const base = mockSupabaseAdmin();
  base.from = vi.fn().mockImplementation((table: string) => {
    if (table === 'team_members') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
      };
    }
    if (table === 'github_connections') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { github_login: githubLogin }, error: null }),
      };
    }
    // fallback
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  });
  return base;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabaseAdmin()),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ data: 'ghp_decrypted_token_123', error: null }),
  }),
}));

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------- helpers ----------

async function getCreateClient() {
  const { createClient } = await import('@/lib/supabase/server');
  return createClient as ReturnType<typeof vi.fn>;
}

async function getCreateServiceClient() {
  const { createServiceClient } = await import('@/lib/supabase/service');
  return createServiceClient as ReturnType<typeof vi.fn>;
}

function makeRequest(org: string, id = 'conn-1') {
  return new NextRequest(`http://localhost:3000/api/github/connections/${id}/repos?org=${org}`);
}

const paramsPromise = (id = 'conn-1') => Promise.resolve({ id });

// ---------- tests ----------

describe('GET /api/github/connections/[id]/repos', () => {
  it('returns 403 when user is not authenticated', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseUnauthenticated());
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });
    expect(res.status).toBe(403);
  });

  it('returns 403 when user is not admin', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseNonAdmin());
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });
    expect(res.status).toBe(403);
  });

  it('returns 400 when org param is missing', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    const { GET } = await import('./route.js');

    const req = new NextRequest('http://localhost:3000/api/github/connections/conn-1/repos');
    const res = await GET(req, { params: paramsPromise() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/org/i);
  });

  it('returns 400 when org param fails SAFE_PATTERN validation', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('../etc/passwd'), { params: paramsPromise() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  it('accepts valid org names with dots, hyphens, and underscores', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdminWithConnection('other-user'));
    const { GET } = await import('./route.js');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const res = await GET(makeRequest('my-org_v2.0'), { params: paramsPromise() });
    expect(res.status).toBe(200);
  });

  it('returns 500 when token decryption fails', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdminWithConnection('any'));
    const createServiceClient = await getCreateServiceClient();
    createServiceClient.mockReturnValueOnce({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'decrypt failed' } }),
    });
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/token/i);
  });

  it('uses /user/repos endpoint when org matches github_login (personal account)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdminWithConnection('my-user'));
    const { GET } = await import('./route.js');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { full_name: 'my-user/repo-a', name: 'repo-a', owner: { login: 'my-user' }, private: false },
      ]),
    });

    const res = await GET(makeRequest('my-user'), { params: paramsPromise() });
    expect(res.status).toBe(200);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/user/repos');
    expect(url).not.toContain('/orgs/');
    expect(opts.headers.Authorization).toBe('Bearer ghp_decrypted_token_123');
  });

  it('uses /orgs/:org/repos endpoint when org differs from github_login', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdminWithConnection('my-user'));
    const { GET } = await import('./route.js');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { full_name: 'acme-corp/repo-b', name: 'repo-b', owner: { login: 'acme-corp' }, private: true },
      ]),
    });

    const res = await GET(makeRequest('acme-corp'), { params: paramsPromise() });
    expect(res.status).toBe(200);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/orgs/acme-corp/repos');
    expect(url).not.toContain('/user/repos');
  });

  it('returns mapped repo data with owner, name, full_name, private fields', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdminWithConnection('other'));
    const { GET } = await import('./route.js');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { full_name: 'org/repo-1', name: 'repo-1', owner: { login: 'org' }, private: false, html_url: 'https://...' },
        { full_name: 'org/repo-2', name: 'repo-2', owner: { login: 'org' }, private: true, html_url: 'https://...' },
      ]),
    });

    const res = await GET(makeRequest('org'), { params: paramsPromise() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ owner: 'org', name: 'repo-1', full_name: 'org/repo-1', private: false });
    expect(body[1]).toEqual({ owner: 'org', name: 'repo-2', full_name: 'org/repo-2', private: true });
    // Verify extra fields are stripped
    expect(body[0]).not.toHaveProperty('html_url');
  });

  it('returns 502 when GitHub API returns an error', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdminWithConnection('other'));
    const { GET } = await import('./route.js');

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    const res = await GET(makeRequest('some-org'), { params: paramsPromise() });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/github/i);
  });
});
