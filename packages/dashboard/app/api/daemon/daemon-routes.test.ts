import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ---------- shared mock factories ----------

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

function mockSupabaseNonAdmin() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-2' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
    }),
  };
}

function mockSupabaseNoTeamMember() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-3' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'not found' } }),
    }),
  };
}

function mockSupabaseUnauthenticated() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabaseAdmin()),
}));

vi.stubEnv('DAEMON_URL', 'http://localhost:9800');

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

// ---------- helper ----------

async function getCreateClient() {
  const { createClient } = await import('@/lib/supabase/server');
  return createClient as ReturnType<typeof vi.fn>;
}

// ---------- routes that require admin, use inline auth (POST) ----------

const inlineAuthRoutes = [
  { name: 'pause', path: './pause/route.js', daemonPath: '/pause' },
  { name: 'resume', path: './resume/route.js', daemonPath: '/resume' },
  { name: 'repos-reload', path: './repos-reload/route.js', daemonPath: '/repos/reload' },
  { name: 'issues/scan', path: './issues/scan/route.js', daemonPath: '/issues/scan' },
];

describe.each(inlineAuthRoutes)('POST /api/daemon/$name', ({ path, daemonPath }) => {
  it('returns 401 when not authenticated', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseUnauthenticated());
    const { POST } = await import(path);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not admin', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseNonAdmin());
    const { POST } = await import(path);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies to daemon and returns response on success', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { POST } = await import(path);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:9800${daemonPath}`,
      expect.objectContaining({ method: 'POST', headers: { 'X-Requested-By': 'dashboard' } }),
    );
  });

  it('returns 503 when daemon is unreachable', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import(path);
    const res = await POST();
    expect(res.status).toBe(503);
  });

  it('returns 500 when DAEMON_URL is not configured', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    const { POST } = await import(path);
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('returns 502 when daemon returns non-JSON body (#423)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Internal Server Error</html>', { status: 500 }),
    );
    const { POST } = await import(path);
    const res = await POST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/non-JSON/);
  });
});

// ---------- remote-control/restart ----------

describe('POST /api/daemon/remote-control/restart', () => {
  it('returns 401 when not authenticated', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseUnauthenticated());
    const { POST } = await import('./remote-control/restart/route.js');
    const res = await POST();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not admin', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseNonAdmin());
    const { POST } = await import('./remote-control/restart/route.js');
    const res = await POST();
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies to daemon and returns response on success', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { POST } = await import('./remote-control/restart/route.js');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/remote-control/restart',
      expect.objectContaining({ method: 'POST', headers: { 'X-Requested-By': 'dashboard' } }),
    );
  });

  it('returns 503 when daemon is unreachable', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import('./remote-control/restart/route.js');
    const res = await POST();
    expect(res.status).toBe(503);
  });

  it('returns 500 when DAEMON_URL is not configured', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    const { POST } = await import('./remote-control/restart/route.js');
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('returns 502 when daemon returns non-JSON body (#423)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Internal Server Error</html>', { status: 500 }),
    );
    const { POST } = await import('./remote-control/restart/route.js');
    const res = await POST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/non-JSON/);
  });
});

// ---------- status route (GET, auth-only, no admin check) ----------

describe('GET /api/daemon/status', () => {
  it('returns 401 when not authenticated', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseUnauthenticated());
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when user has no team membership (#276)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseNoTeamMember());
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows non-admin team members', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseNonAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'running', active_runs: 2 }), { status: 200 }),
    );
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'running', active_runs: 2 });
  });

  it('proxies to daemon and returns status', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'idle', active_runs: 0 }), { status: 200 }),
    );
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fetches daemon status without cache (no-store) to avoid stale data (#174)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'running' }), { status: 200 }),
    );
    const { GET } = await import('./status/route.js');
    await GET();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/status',
      expect.objectContaining({ cache: 'no-store' }),
    );
    // Ensure revalidate is NOT set — it caused stale status when client polls every 5s
    const callArgs = fetchMock.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('next');
  });

  it('returns 503 with fallback body when daemon is unreachable', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.state).toBe('offline');
  });

  it('returns 500 when DAEMON_URL is not configured', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('returns 502 when daemon returns non-JSON body (#423)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseAdmin());
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Internal Server Error</html>', { status: 500 }),
    );
    const { GET } = await import('./status/route.js');
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/non-JSON/);
  });
});
