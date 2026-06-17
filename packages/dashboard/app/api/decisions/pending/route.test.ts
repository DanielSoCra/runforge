import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror the daemon-route test harness: mock the auth guard, stub DAEMON_URL, and
// replace global fetch (daemonFetch calls global fetch under the hood).
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

function makeRequest(url = 'http://localhost/api/decisions/pending') {
  // The handler only reads request.nextUrl.searchParams; a NextRequest-shaped
  // stub with a nextUrl URL is enough for the unit.
  return { nextUrl: new URL(url) } as unknown as import('next/server').NextRequest;
}

const rows = [
  {
    decision_id: 'dec-1',
    status: 'notified',
    risk_class: 'ORANGE',
    created_at: '2026-06-18T09:30:00.000Z',
    question: { kind: 'text', value: 'Merge PR #482?' },
    score: 80,
    why_ranked: 'orange, 2h',
  },
];

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

describe('GET /api/decisions/pending', () => {
  it('proxies to the daemon /decisions/pending and returns the ranked rows', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(rows), { status: 200 }),
    );
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9800/decisions/pending',
      expect.any(Object),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].decision_id).toBe('dec-1');
    expect(body.unavailable).not.toBe(true);
  });

  it('maps an unreachable daemon to the degraded shape (never throws)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.unavailable).toBe(true);
  });

  it('maps a daemon 503 to the degraded shape', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'decision index unavailable' }), {
        status: 503,
      }),
    );
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.unavailable).toBe(true);
  });

  it('maps a missing DAEMON_URL (DaemonConfigError) to the degraded shape', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest());

    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.unavailable).toBe(true);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });
});
