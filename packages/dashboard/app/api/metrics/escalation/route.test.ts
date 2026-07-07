import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  requireDashboardUser: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
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

function makeRequest(url = 'http://localhost/api/metrics/escalation') {
  return { nextUrl: new URL(url) } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  authMocks.requireDashboardUser.mockReset();
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

describe('GET /api/metrics/escalation', () => {
  it('proxies to the daemon /metrics/escalation and returns weeks', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ weeks: [{ week: '2026-W01' }] }), { status: 200 }),
    );
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/metrics/escalation',
      expect.any(Object),
    );
    const body = await res.json();
    expect(body.weeks).toHaveLength(1);
    expect(body.unavailable).not.toBe(true);
  });

  it('maps an unreachable daemon to the degraded shape', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    const body = await res.json();
    expect(body.weeks).toEqual([]);
    expect(body.unavailable).toBe(true);
  });

  it('returns 500 when daemon rejects with 401/403 (DaemonAuthError)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('unauthorized', { status: 401 }),
    );
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/RUNFORGE_CONTROL_TOKEN/);
  });
});
