import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DashboardAuthError,
  getDashboardAuthError,
  isDashboardAdmin,
  requireDashboardAdmin,
  requireDashboardUser,
} from './require-session';

function authWithSession(user: { id?: string; role?: unknown } | null) {
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(
        user
          ? {
              user: {
                id: user.id ?? 'operator-1',
                email: 'operator@example.test',
                name: 'Operator',
                role: user.role,
              },
              session: { id: 'session-1' },
            }
          : null,
      ),
    },
  };
}

function membershipWithRole(role: 'admin' | 'viewer' | null = 'viewer') {
  return {
    readMembership: vi.fn().mockResolvedValue(
      role
        ? { ok: true, value: { role } }
        : {
            ok: false,
            error: 'not-found',
            message: 'operator membership was not found',
          },
    ),
  };
}

describe('requireDashboardUser', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows a viewer session through the viewer gate', async () => {
    const auth = authWithSession({ role: 'viewer' });
    const membershipLookup = membershipWithRole('viewer');

    await expect(
      requireDashboardUser({ auth, headers: new Headers(), membershipLookup }),
    ).resolves.toMatchObject({
      user: { id: 'operator-1', role: 'viewer' },
    });
    expect(auth.api.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
  });

  it('throws 401 when Better Auth has no session', async () => {
    await expect(
      requireDashboardUser({
        auth: authWithSession(null),
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ message: 'Unauthorized', status: 401 });
  });

  it('throws 401 when the session has no stable operator id', async () => {
    await expect(
      requireDashboardUser({
        auth: authWithSession({ id: '', role: 'viewer' }),
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ message: 'Unauthorized', status: 401 });
  });

  it('throws 403 when the operator has no app-owned membership', async () => {
    await expect(
      requireDashboardUser({
        auth: authWithSession({ role: 'owner' }),
        headers: new Headers(),
        membershipLookup: membershipWithRole(null),
      }),
    ).rejects.toMatchObject({
      message: 'Access denied — ask an admin to invite you',
      status: 403,
    });
  });

  it('uses LOCAL_AUTH_BYPASS only in a non-production context', async () => {
    const auth = authWithSession(null);

    await expect(
      requireDashboardAdmin({
        auth,
        headers: new Headers(),
        env: { LOCAL_AUTH_BYPASS: 'true', NODE_ENV: 'development' },
      }),
    ).resolves.toMatchObject({
      user: { id: '00000000-0000-0000-0000-000000000000', role: 'admin' },
    });
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('does not preserve the legacy AUTH_DISABLED bypass', async () => {
    await expect(
      requireDashboardUser({
        auth: authWithSession(null),
        headers: new Headers(),
        env: { AUTH_DISABLED: 'true' },
      }),
    ).rejects.toMatchObject({ message: 'Unauthorized', status: 401 });
  });

  it('refuses LOCAL_AUTH_BYPASS when a production indicator exists', async () => {
    const auth = authWithSession(null);

    await expect(
      requireDashboardAdmin({
        auth,
        headers: new Headers(),
        env: { LOCAL_AUTH_BYPASS: 'true', NODE_ENV: 'production' },
      }),
    ).rejects.toMatchObject({ message: 'Unauthorized', status: 401 });
    expect(auth.api.getSession).toHaveBeenCalled();
  });
});

describe('requireDashboardAdmin', () => {
  it('allows admins through the admin gate', async () => {
    await expect(
      requireDashboardAdmin({
        auth: authWithSession({ role: 'admin' }),
        headers: new Headers(),
        membershipLookup: membershipWithRole('admin'),
      }),
    ).resolves.toMatchObject({ user: { role: 'admin' } });
  });

  it('uses membership role instead of a stale session role', async () => {
    await expect(
      requireDashboardAdmin({
        auth: authWithSession({ role: 'viewer' }),
        headers: new Headers(),
        membershipLookup: membershipWithRole('admin'),
      }),
    ).resolves.toMatchObject({ user: { role: 'admin' } });
  });

  it('denies viewers at the admin gate', async () => {
    await expect(
      requireDashboardAdmin({
        auth: authWithSession({ role: 'admin' }),
        headers: new Headers(),
        membershipLookup: membershipWithRole('viewer'),
      }),
    ).rejects.toMatchObject({
      message: 'Admin access required',
      status: 403,
    });
  });

  it('fails closed when membership lookup is unavailable', async () => {
    await expect(
      requireDashboardAdmin({
        auth: authWithSession({ role: 'admin' }),
        headers: new Headers(),
        membershipLookup: {
          readMembership: vi.fn().mockResolvedValue({
            ok: false,
            error: 'unavailable',
            message: 'database offline',
          }),
        },
      }),
    ).rejects.toMatchObject({
      message: 'Authorization unavailable',
      status: 403,
    });
  });
});

describe('isDashboardAdmin', () => {
  it('returns true for admins', async () => {
    await expect(
      isDashboardAdmin({
        auth: authWithSession({ role: 'admin' }),
        headers: new Headers(),
        membershipLookup: membershipWithRole('admin'),
      }),
    ).resolves.toBe(true);
  });

  it('returns false for viewers and missing sessions', async () => {
    await expect(
      isDashboardAdmin({
        auth: authWithSession({ role: 'admin' }),
        headers: new Headers(),
        membershipLookup: membershipWithRole('viewer'),
      }),
    ).resolves.toBe(false);
    await expect(
      isDashboardAdmin({ auth: authWithSession(null), headers: new Headers() }),
    ).resolves.toBe(false);
  });
});

describe('getDashboardAuthError', () => {
  it('preserves DashboardAuthError status', () => {
    const error = new DashboardAuthError('Denied', 403);

    expect(getDashboardAuthError(error)).toBe(error);
  });

  it('maps unknown unauthorized errors by message', () => {
    expect(getDashboardAuthError(new Error('Unauthorized'))).toMatchObject({
      message: 'Unauthorized',
      status: 401,
    });
  });
});
