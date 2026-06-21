import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GATE (immovable) — admin-gated proxy for operator REVEAL (`POST /api/decisions/[id]/reveal`).
 * Reveal returns decrypted withheld content, so it MUST be admin-only and must forward an actor
 * for the daemon's reveal audit. Mirrors the answer-route gate: mock the auth guard, stub
 * DAEMON_URL + fetch, re-import the handler per test.
 */

const authMocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: authMocks.requireDashboardAdmin,
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
  authMocks.requireDashboardAdmin.mockReset();
  authMocks.requireDashboardAdmin.mockResolvedValue({
    user: { id: 'admin-1', email: 'admin@example.com', role: 'admin' },
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

const DECISION_ID = 'owner/repo#42';
const ENCODED_ID = encodeURIComponent(DECISION_ID);
const REF = 'protected://01ABCDEF';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/decisions/${ENCODED_ID}/reveal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const ctx = () => ({ params: Promise.resolve({ id: DECISION_ID }) });

describe('POST /api/decisions/[id]/reveal', () => {
  it('rejects with 401 when there is no authenticated session (no daemon call)', async () => {
    authMocks.requireDashboardAdmin.mockRejectedValueOnce(authError('Unauthorized', 401));
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({ ref: REF }), ctx());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the operator is not an admin (reveal is admin-only, no daemon call)', async () => {
    authMocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Access denied — admin only', 403),
    );
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({ ref: REF }), ctx());
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid ref with 400, never a thrown 500', async () => {
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({}), ctx());
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to the daemon reveal path with the percent-encoded id, ref + actor; returns daemon 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ field: 'context', value: 'TOP-SECRET' }), { status: 200 }),
    );
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({ ref: REF }), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ field: 'context', value: 'TOP-SECRET' });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:9800/decisions/${ENCODED_ID}/reveal`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Requested-By': 'dashboard' }),
      }),
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.ref).toBe(REF);
    expect(typeof sentBody.actor).toBe('string'); // operator identity forwarded for the audit
    expect(sentBody.actor.length).toBeGreaterThan(0);
  });

  it('passes a daemon 404 (ref not part of this decision) straight through', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'ref not found for decision' }), { status: 404 }),
    );
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({ ref: REF }), ctx());
    expect(res.status).toBe(404);
  });

  it('maps an unreachable daemon to a degraded 503 (does not throw)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({ ref: REF }), ctx());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBeTruthy();
  });

  it('maps a missing DAEMON_URL to a 500 config error (does not throw)', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { POST } = await import('./route.js');
    const res = await POST(makeRequest({ ref: REF }), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/DAEMON_URL/);
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  });
});
