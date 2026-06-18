import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proxy-route gate for the operator ANSWER (`POST /api/decisions/answer`),
 * mirroring `app/api/daemon/daemon-routes.test.ts`: mock the dashboard auth guard,
 * stub `DAEMON_URL`, stub `globalThis.fetch`, and `await import('./route.js')` so
 * each test re-imports the handler against the mocked env. RED until Kimi
 * implements the handler body.
 */

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

function authError(message: string, status: 401 | 403) {
  return Object.assign(new Error(message), { status });
}

/** Build a POST request to the answer proxy with a JSON body. */
function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/decisions/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A decision id with characters that MUST be percent-encoded in the daemon path
// (the daemon route is `/decisions/:id/answer`). `owner/repo#42` → `owner%2Frepo%2342`.
const DECISION_ID = 'owner/repo#42';
const ENCODED_ID = encodeURIComponent(DECISION_ID);

describe('POST /api/decisions/answer', () => {
  it('rejects with 401 when there is no authenticated session', async () => {
    authMocks.requireDashboardUser.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { POST } = await import('./route.js');

    const res = await POST(makeRequest({ decision_id: 'dec-1', chosen_option: 'approve' }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the operator lacks an app-owned role', async () => {
    authMocks.requireDashboardUser.mockRejectedValueOnce(
      authError('Access denied — ask an admin to invite you', 403),
    );
    const { POST } = await import('./route.js');

    const res = await POST(makeRequest({ decision_id: 'dec-1', chosen_option: 'approve' }));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to the daemon answer path with the percent-encoded id + body, returns the daemon 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ answered: true, chosen_option: 'approve' }), {
        status: 200,
      }),
    );
    const { POST } = await import('./route.js');

    const res = await POST(
      makeRequest({ decision_id: DECISION_ID, chosen_option: 'approve' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answered: true, chosen_option: 'approve' });
    // The id is percent-encoded into the daemon path; the CSRF header is injected
    // by daemonFetch; the body carries chosen_option.
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:9800/decisions/${ENCODED_ID}/answer`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Requested-By': 'dashboard' }),
      }),
    );
    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody).toEqual({ chosen_option: 'approve' });
  });

  it('passes the daemon 409 (not answerable) straight through', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'decision is not answerable' }), {
        status: 409,
      }),
    );
    const { POST } = await import('./route.js');

    const res = await POST(
      makeRequest({ decision_id: 'dec-1', chosen_option: 'approve' }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not answerable/i);
  });

  it('passes the daemon 400 (malformed/unsupported option) straight through', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'chosen_option must be one of the decision options' }),
        { status: 400 },
      ),
    );
    const { POST } = await import('./route.js');

    const res = await POST(
      makeRequest({ decision_id: 'dec-1', chosen_option: 'maybe' }),
    );

    expect(res.status).toBe(400);
  });

  it('maps an unreachable daemon to a degraded 503 (does not throw)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import('./route.js');

    const res = await POST(
      makeRequest({ decision_id: 'dec-1', chosen_option: 'approve' }),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('maps a missing DAEMON_URL to a 500 config error (does not throw)', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { POST } = await import('./route.js');

    const res = await POST(
      makeRequest({ decision_id: 'dec-1', chosen_option: 'approve' }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });

  it('maps a non-JSON daemon body to a 502 (#423 pattern)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Internal Server Error</html>', { status: 500 }),
    );
    const { POST } = await import('./route.js');

    const res = await POST(
      makeRequest({ decision_id: 'dec-1', chosen_option: 'approve' }),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/non-JSON/);
  });
});
