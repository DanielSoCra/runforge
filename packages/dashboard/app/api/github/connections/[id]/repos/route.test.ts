import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCredential: vi.fn(),
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
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    githubConnections: {
      readCredential: mocks.readCredential,
    },
  }),
}));

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  mocks.requireDashboardAdmin.mockReset();
  mocks.readCredential.mockReset();
  mocks.requireDashboardAdmin.mockResolvedValue({
    user: { id: 'admin-1', role: 'admin' },
  });
  mocks.readCredential.mockResolvedValue({
    ok: true,
    value: { githubLogin: 'my-user', token: 'ghp_decrypted_token_123' },
  });
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function authError(message: string, status: 401 | 403) {
  return Object.assign(new Error(message), { status });
}

function makeRequest(org: string, id = 'conn-1') {
  return new NextRequest(
    `http://localhost:3000/api/github/connections/${id}/repos?org=${org}`,
  );
}

const paramsPromise = (id = 'conn-1') => Promise.resolve({ id });

describe('GET /api/github/connections/[id]/repos', () => {
  it('returns 401 when user is not authenticated (#549)', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });

    expect(res.status).toBe(401);
    expect(mocks.readCredential).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not admin', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Admin access required', 403),
    );
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });

    expect(res.status).toBe(403);
    expect(mocks.readCredential).not.toHaveBeenCalled();
  });

  it('returns 400 when org param is missing', async () => {
    const { GET } = await import('./route.js');

    const req = new NextRequest(
      'http://localhost:3000/api/github/connections/conn-1/repos',
    );
    const res = await GET(req, { params: paramsPromise() });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/org/i);
    expect(mocks.readCredential).not.toHaveBeenCalled();
  });

  it('returns 400 when org param fails SAFE_PATTERN validation', async () => {
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('../etc/passwd'), {
      params: paramsPromise(),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
    expect(mocks.readCredential).not.toHaveBeenCalled();
  });

  it('accepts valid org names with dots, hyphens, and underscores', async () => {
    const { GET } = await import('./route.js');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const res = await GET(makeRequest('my-org_v2.0'), {
      params: paramsPromise(),
    });

    expect(res.status).toBe(200);
  });

  it('returns 500 when token decryption fails', async () => {
    mocks.readCredential.mockResolvedValueOnce({
      ok: false,
      error: 'denied',
      message: 'decrypt failed',
    });
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/token/i);
  });

  it('uses /user/repos endpoint when org matches github_login (personal account)', async () => {
    const { GET } = await import('./route.js');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            full_name: 'my-user/repo-a',
            name: 'repo-a',
            owner: { login: 'my-user' },
            private: false,
          },
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
    const { GET } = await import('./route.js');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            full_name: 'acme-corp/repo-b',
            name: 'repo-b',
            owner: { login: 'acme-corp' },
            private: true,
          },
        ]),
    });

    const res = await GET(makeRequest('acme-corp'), {
      params: paramsPromise(),
    });

    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/orgs/acme-corp/repos');
    expect(url).not.toContain('/user/repos');
  });

  it('returns mapped repo data with owner, name, full_name, private fields', async () => {
    const { GET } = await import('./route.js');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            full_name: 'org/repo-1',
            name: 'repo-1',
            owner: { login: 'org' },
            private: false,
            html_url: 'https://...',
          },
          {
            full_name: 'org/repo-2',
            name: 'repo-2',
            owner: { login: 'org' },
            private: true,
            html_url: 'https://...',
          },
        ]),
    });

    const res = await GET(makeRequest('org'), { params: paramsPromise() });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      owner: 'org',
      name: 'repo-1',
      full_name: 'org/repo-1',
      private: false,
    });
    expect(body[1]).toEqual({
      owner: 'org',
      name: 'repo-2',
      full_name: 'org/repo-2',
      private: true,
    });
    expect(body[0]).not.toHaveProperty('html_url');
  });

  it('returns 500 when the app-owned credential lookup fails (#354)', async () => {
    mocks.readCredential.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'connection timeout',
    });
    const { GET } = await import('./route.js');

    const res = await GET(makeRequest('my-org'), { params: paramsPromise() });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/database/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when GitHub API returns an error', async () => {
    const { GET } = await import('./route.js');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    const res = await GET(makeRequest('some-org'), {
      params: paramsPromise(),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/github/i);
  });
});
