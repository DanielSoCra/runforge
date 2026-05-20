import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
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
      listOrganizations: mocks.listOrganizations,
    },
  }),
}));

function authError(message: string, status: 401 | 403) {
  return Object.assign(new Error(message), { status });
}

const paramsPromise = (id = 'conn-1') => Promise.resolve({ id });

describe('GET /api/github/connections/[id]/orgs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
    mocks.listOrganizations.mockResolvedValue({ ok: true, value: [] });
  });

  it('returns 401 when user is not authenticated (#549)', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Unauthorized', 401),
    );
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as never, {
      params: paramsPromise(),
    });

    expect(res.status).toBe(401);
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not admin', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Admin access required', 403),
    );
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as never, {
      params: paramsPromise(),
    });

    expect(res.status).toBe(403);
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it('returns 500 when org lookup fails (#576)', async () => {
    mocks.listOrganizations.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'db unavailable',
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as never, {
      params: paramsPromise('conn-500'),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to fetch organizations',
    });
    expect(mocks.listOrganizations).toHaveBeenCalledWith('conn-500');
    expect(consoleSpy).toHaveBeenCalledWith(
      '[orgs] Failed to fetch orgs for connection:',
      'db unavailable',
    );
    consoleSpy.mockRestore();
  });

  it('returns selected organizations for the requested connection (#576)', async () => {
    mocks.listOrganizations.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          id: 'org-1',
          login: 'acme',
          name: 'Acme',
          avatarUrl: 'https://example.com/acme.png',
          isSelected: true,
        },
        {
          id: 'org-2',
          login: 'tools',
          name: null,
          avatarUrl: null,
          isSelected: false,
        },
      ],
    });
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as never, {
      params: paramsPromise('conn-200'),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      {
        id: 'org-1',
        login: 'acme',
        name: 'Acme',
        avatar_url: 'https://example.com/acme.png',
        is_selected: true,
      },
      {
        id: 'org-2',
        login: 'tools',
        name: null,
        avatar_url: null,
        is_selected: false,
      },
    ]);
    expect(mocks.listOrganizations).toHaveBeenCalledWith('conn-200');
  });
});
