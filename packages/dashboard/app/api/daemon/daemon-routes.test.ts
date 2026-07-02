import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  requireDashboardUser: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: authMocks.requireDashboardAdmin,
  requireDashboardUser: authMocks.requireDashboardUser,
  getDashboardAuthError: (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Forbidden';
    const status =
      'status' in Object(error)
        ? (error as { status: 401 | 403 }).status
        : message === 'Unauthorized'
          ? 401
          : 403;
    return { message, status };
  },
}));

vi.stubEnv('DAEMON_URL', 'http://localhost:9800');

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  authMocks.requireDashboardAdmin.mockReset();
  authMocks.requireDashboardUser.mockReset();
  authMocks.requireDashboardAdmin.mockResolvedValue({
    user: { id: 'admin-1', role: 'admin' },
  });
  authMocks.requireDashboardUser.mockResolvedValue({
    user: { id: 'viewer-1', role: 'viewer' },
  });
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

function authError(message: string, status: 401 | 403) {
  return Object.assign(new Error(message), { status });
}

const adminRoutes = [
  { name: 'pause', path: './pause/route.js', daemonPath: '/pause' },
  { name: 'resume', path: './resume/route.js', daemonPath: '/resume' },
  { name: 'halt', path: './halt/route.js', daemonPath: '/halt' },
  {
    name: 'repos-reload',
    path: './repos-reload/route.js',
    daemonPath: '/repos/reload',
  },
  {
    name: 'issues/scan',
    path: './issues/scan/route.js',
    daemonPath: '/issues/scan',
  },
  { name: 'release', path: './release/route.js', daemonPath: '/release' },
  {
    name: 'remote-control/restart',
    path: './remote-control/restart/route.js',
    daemonPath: '/remote-control/restart',
  },
];

describe.each(adminRoutes)('POST /api/daemon/$name', ({ path, daemonPath }) => {
  it('returns 401 when Better Auth has no authenticated session', async () => {
    authMocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { POST } = await import(path);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the operator is not an admin', async () => {
    authMocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Admin access required', 403),
    );
    const { POST } = await import(path);

    const res = await POST();

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies to daemon and returns response on success', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { POST } = await import(path);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(authMocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:9800${daemonPath}`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Requested-By': 'dashboard' },
      }),
    );
  });

  it('returns 503 when daemon is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import(path);

    const res = await POST();

    expect(res.status).toBe(503);
  });

  it('returns 500 when DAEMON_URL is not configured', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { POST } = await import(path);

    const res = await POST();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('returns 502 when daemon returns non-JSON body (#423)', async () => {
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

describe('POST /api/daemon/halt', () => {
  it('forwards Authorization: Bearer from AUTO_CLAUDE_CONTROL_TOKEN when configured', async () => {
    vi.stubEnv('AUTO_CLAUDE_CONTROL_TOKEN', 'dashboard-secret');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ halted: true, parked: 2, terminated: 1, escalated: 0 }), {
        status: 200,
      }),
    );
    const { POST } = await import('./halt/route.js');

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      halted: true,
      parked: 2,
      terminated: 1,
      escalated: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/halt',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Requested-By': 'dashboard',
          Authorization: 'Bearer dashboard-secret',
        }),
      }),
    );
  });

  it('omits Authorization when AUTO_CLAUDE_CONTROL_TOKEN is unset', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ halted: true }), { status: 200 }),
    );
    const { POST } = await import('./halt/route.js');

    await POST();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/halt',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Requested-By': 'dashboard',
        }),
      }),
    );
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });
});

describe('GET /api/daemon/status', () => {
  it('returns 401 when Better Auth has no authenticated session', async () => {
    authMocks.requireDashboardUser.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { GET } = await import('./status/route.js');

    const res = await GET();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the operator has no app-owned role (#276)', async () => {
    authMocks.requireDashboardUser.mockRejectedValueOnce(
      authError('Access denied — ask an admin to invite you', 403),
    );
    const { GET } = await import('./status/route.js');

    const res = await GET();

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows non-admin operators to read daemon status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'running', active_runs: 2 }), {
        status: 200,
      }),
    );
    const { GET } = await import('./status/route.js');

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'running', active_runs: 2 });
    expect(authMocks.requireDashboardUser).toHaveBeenCalledTimes(1);
  });

  it('proxies to daemon and returns status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'idle', active_runs: 0 }), {
        status: 200,
      }),
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
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'running' }), { status: 200 }),
    );
    const { GET } = await import('./status/route.js');

    await GET();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/status',
      expect.objectContaining({ cache: 'no-store' }),
    );
    const callArgs = fetchMock.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('next');
  });

  it('returns 503 with fallback body when daemon is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { GET } = await import('./status/route.js');

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.state).toBe('offline');
  });

  it('returns 500 when DAEMON_URL is not configured', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { GET } = await import('./status/route.js');

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('returns 502 when daemon returns non-JSON body (#423)', async () => {
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
