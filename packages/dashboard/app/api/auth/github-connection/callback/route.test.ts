import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  storeOAuthConnection: vi.fn(),
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
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    githubConnections: {
      storeOAuthConnection: mocks.storeOAuthConnection,
    },
  }),
}));

const mockFetch = vi.fn();

function authError(message: string, status: 401 | 403) {
  return Object.assign(new Error(message), { status });
}

function callbackRequest({
  code = 'valid-code',
  state = 'match',
  cookieState = 'match',
} = {}) {
  return new NextRequest(
    `http://localhost:3000/api/auth/github-connection/callback?code=${code}&state=${state}`,
    { headers: { cookie: `gh_oauth_state=${cookieState}` } },
  );
}

function mockSuccessfulGitHubResponses() {
  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'ghp_test', scope: 'repo,read:org' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        login: 'dan',
        name: 'Dan',
        avatar_url: 'https://a.b/c.png',
        id: 1,
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 10,
          login: 'acme',
          name: 'Acme Corp',
          avatar_url: 'https://x.y/z.png',
        },
      ],
    });
}

describe('GET /api/auth/github-connection/callback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'cid');
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'csec');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mocks.requireDashboardAdmin.mockReset();
    mocks.storeOAuthConnection.mockReset();
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'user-1', role: 'admin' },
    });
    mocks.storeOAuthConnection.mockResolvedValue({
      ok: true,
      value: 'conn-id',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 302/307 redirect on CSRF state mismatch', async () => {
    const { GET } = await import('./route.js');

    const res = await GET(
      callbackRequest({ state: 'wrong', cookieState: 'correct-state' }),
    );

    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('error=invalid_state');
    expect(mocks.storeOAuthConnection).not.toHaveBeenCalled();
  });

  it('exchanges code and stores connection on valid state', async () => {
    mockSuccessfulGitHubResponses();
    const { GET } = await import('./route.js');

    const res = await GET(callbackRequest());

    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings');
    expect(mocks.storeOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: 'user-1',
        displayName: 'dan (personal)',
        githubLogin: 'dan',
        organizations: [
          {
            githubId: 1,
            login: 'dan',
            name: 'Dan',
            avatarUrl: 'https://a.b/c.png',
          },
          {
            githubId: 10,
            login: 'acme',
            name: 'Acme Corp',
            avatarUrl: 'https://x.y/z.png',
          },
        ],
      }),
      'ghp_test',
    );
  });

  it('redirects with error=not_authenticated when the admin gate has no session', async () => {
    mockSuccessfulGitHubResponses();
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { GET } = await import('./route.js');

    const res = await GET(callbackRequest());

    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location')).toContain('error=not_authenticated');
    expect(mocks.storeOAuthConnection).not.toHaveBeenCalled();
  });

  it('redirects with error=not_admin when the operator is not an admin', async () => {
    mockSuccessfulGitHubResponses();
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Admin access required', 403),
    );
    const { GET } = await import('./route.js');

    const res = await GET(callbackRequest());

    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location')).toContain('error=not_admin');
    expect(mocks.storeOAuthConnection).not.toHaveBeenCalled();
  });

  it('redirects with error=store_failed when app-owned credential storage fails', async () => {
    mockSuccessfulGitHubResponses();
    mocks.storeOAuthConnection.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'constraint violation',
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('./route.js');

    const res = await GET(callbackRequest());

    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location')).toContain('error=store_failed');
    expect(consoleSpy).toHaveBeenCalledWith(
      '[github-connection] failed to store GitHub OAuth connection:',
      'constraint violation',
    );
    consoleSpy.mockRestore();
  });
});
