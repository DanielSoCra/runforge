import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proxy-route gate for the per-decision DETAIL (`GET /api/decisions/:id`), mirroring
 * the answer/pending proxy tests: mock the dashboard READ auth guard, stub DAEMON_URL +
 * globalThis.fetch, and `await import('./route.js')` per test. RED until the handler is implemented.
 */
const authMocks = vi.hoisted(() => ({ requireDashboardUser: vi.fn() }));

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

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  authMocks.requireDashboardUser.mockReset();
  authMocks.requireDashboardUser.mockResolvedValue({ user: { id: 'user-1', role: 'viewer' } });
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

const DECISION_ID = 'owner/repo#42';
const ENCODED_ID = encodeURIComponent(DECISION_ID);

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/decisions/${ENCODED_ID}`, { method: 'GET' });
}
function ctx() {
  return { params: Promise.resolve({ id: DECISION_ID }) };
}

const DETAIL = {
  decision_id: DECISION_ID,
  status: 'notified',
  risk_class: 'P1',
  deployment: 'dep-main',
  source_url: 'https://github.com/org/repo/issues/42',
  reversibility: 'reversible',
  recommended_option: 'approve',
  expires_at: null,
  created_at: '2026-06-21T09:30:00.000Z',
  question: { kind: 'text', value: 'Merge?' },
  context: null,
  consequence_of_no_answer: null,
  options: [{ id: 'approve', label: { kind: 'text', value: 'Approve' } }],
};

describe('GET /api/decisions/[id]', () => {
  it('rejects with 401 when there is no authenticated session', async () => {
    authMocks.requireDashboardUser.mockRejectedValueOnce(authError('Unauthorized', 401));
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to the daemon detail path with the percent-encoded id, returns the daemon 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(DETAIL), { status: 200 }));
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).decision_id).toBe(DECISION_ID);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:9800/decisions/${ENCODED_ID}`,
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Requested-By': 'dashboard' }) }),
    );
  });

  it('passes the daemon 404 (unknown decision) straight through', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown decision' }), { status: 404 }));
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(404);
  });

  it('maps an unreachable daemon to a degraded 503 (does not throw)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBeTruthy();
  });

  it('maps a missing DAEMON_URL to a 500 config error (does not throw)', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('maps a non-JSON daemon body to a 502', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>err</html>', { status: 500 }));
    const { GET } = await import('./route.js');
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/non-JSON/);
  });
});
