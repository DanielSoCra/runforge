import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
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

function authError(message: string, status: 401 | 403) {
  return Object.assign(new Error(message), { status });
}

function request() {
  return new NextRequest('http://localhost:3000/api/auth/github-connection');
}

describe('GET /api/auth/github-connection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');
    mocks.requireDashboardAdmin.mockReset();
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redirects to GitHub OAuth with correct params', async () => {
    const { GET } = await import('./route.js');

    const res = await GET(request());

    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('scope=repo');
    expect(mocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
  });

  it('returns 401 if not authenticated', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { GET } = await import('./route.js');

    const res = await GET(request());

    expect(res.status).toBe(401);
  });

  it('returns 403 if authenticated user is not an admin', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Admin access required', 403),
    );
    const { GET } = await import('./route.js');

    const res = await GET(request());

    expect(res.status).toBe(403);
  });

  it('returns 500 when GitHub OAuth is not configured', async () => {
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
    const { GET } = await import('./route.js');

    const res = await GET(request());

    expect(res.status).toBe(500);
  });
});
