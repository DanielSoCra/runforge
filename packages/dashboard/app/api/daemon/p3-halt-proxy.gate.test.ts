// G4 gate: /api/daemon/halt must admin-gate, proxy /halt, and forward Bearer iff configured.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
}));

function hasAuthStatus(error: unknown): error is { status: 401 | 403 } {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: authMocks.requireDashboardAdmin,
  getDashboardAuthError: (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Forbidden';
    const status = hasAuthStatus(error)
      ? error.status
      : message === 'Unauthorized'
        ? 401
        : 403;
    return { message, status };
  },
}));

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

type RouteModule = {
  POST: () => Response | Promise<Response>;
};

const haltRoute = {
  path: './halt/route.js',
  daemonPath: '/halt',
} as const;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
  authMocks.requireDashboardAdmin.mockReset();
  authMocks.requireDashboardAdmin.mockResolvedValue({
    user: { id: 'admin-1', role: 'admin' },
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

function isRouteModule(value: unknown): value is RouteModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'POST' in value &&
    typeof (value as { POST?: unknown }).POST === 'function'
  );
}

async function importHaltRoute(): Promise<RouteModule> {
  try {
    const mod: unknown = await import(haltRoute.path);
    if (!isRouteModule(mod)) {
      throw new Error('halt route module does not export POST');
    }
    return mod;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Expected packages/dashboard/app/api/daemon/halt/route.ts to exist and export POST: ${detail}`,
    );
  }
}

function latestFetchInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('Expected daemon fetch to be called');
  const init = call[1];
  if (typeof init !== 'object' || init === null) {
    throw new Error('Expected daemon fetch init object');
  }
  return init as RequestInit;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);

  const target = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === target);
    return found?.[1] ?? null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return String(value);
  }
  return null;
}

describe('POST /api/daemon/halt', () => {
  it('returns 403 for a non-admin dashboard session', async () => {
    authMocks.requireDashboardAdmin.mockRejectedValueOnce(
      authError('Admin access required', 403),
    );
    const { POST } = await importHaltRoute();

    const res = await POST();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies admin halt requests to daemon /halt with verbatim status and body', async () => {
    const daemonBody = { halted: true, parked: 2, terminated: 1, escalated: 0 };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(daemonBody), { status: 202 }),
    );
    const { POST } = await importHaltRoute();

    const res = await POST();

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(daemonBody);
    expect(authMocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:9800${haltRoute.daemonPath}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('forwards Authorization: Bearer from AUTO_CLAUDE_CONTROL_TOKEN when configured', async () => {
    vi.stubEnv('AUTO_CLAUDE_CONTROL_TOKEN', 'dashboard-secret');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ halted: true }), { status: 200 }),
    );
    const { POST } = await importHaltRoute();

    await POST();

    const init = latestFetchInit();
    expect(headerValue(init.headers, 'X-Requested-By')).toBe('dashboard');
    expect(headerValue(init.headers, 'Authorization')).toBe(
      'Bearer dashboard-secret',
    );
  });

  it('omits Authorization when AUTO_CLAUDE_CONTROL_TOKEN is unset', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ halted: true }), { status: 200 }),
    );
    const { POST } = await importHaltRoute();

    await POST();

    const init = latestFetchInit();
    expect(headerValue(init.headers, 'X-Requested-By')).toBe('dashboard');
    expect(headerValue(init.headers, 'Authorization')).toBeNull();
  });
});
