import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  requireDashboardUser: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: authMocks.requireDashboardAdmin,
  requireDashboardUser: authMocks.requireDashboardUser,
}));

import {
  getOrigin,
  isAdmin,
  isAuthDisabled,
  requireAdmin,
  requireUser,
} from './auth';

describe('legacy dashboard auth compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    vi.stubEnv('LOCAL_AUTH_BYPASS', '');
    vi.stubEnv('AUTH_DISABLED', '');
    vi.stubEnv('NODE_ENV', 'test');
    authMocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', role: 'admin' },
    });
    authMocks.requireDashboardUser.mockResolvedValue({
      user: { id: 'viewer-1', email: 'viewer@test.com', role: 'viewer' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getOrigin', () => {
    it('uses NEXT_PUBLIC_SITE_URL and strips trailing slashes', () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.com///');

      expect(getOrigin()).toBe('https://app.example.com');
    });

    it('derives origin from request URL outside production', () => {
      const request = new Request('http://localhost:3000/login?next=/settings');

      expect(getOrigin(request)).toBe('http://localhost:3000');
    });

    it('requires NEXT_PUBLIC_SITE_URL in production', () => {
      vi.stubEnv('NODE_ENV', 'production');

      expect(() => getOrigin()).toThrow(
        'NEXT_PUBLIC_SITE_URL environment variable is required in production',
      );
    });
  });

  describe('legacy auth wrappers', () => {
    it('requireAdmin delegates to the Better Auth admin gate', async () => {
      await expect(requireAdmin()).resolves.toEqual({
        id: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
      });
      expect(authMocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
    });

    it('requireUser delegates to the Better Auth user gate', async () => {
      await expect(requireUser()).resolves.toEqual({
        id: 'viewer-1',
        email: 'viewer@test.com',
        role: 'viewer',
      });
      expect(authMocks.requireDashboardUser).toHaveBeenCalledTimes(1);
    });

    it('isAdmin returns true when the admin gate passes', async () => {
      await expect(isAdmin()).resolves.toBe(true);
    });

    it('isAdmin returns false when the admin gate rejects', async () => {
      authMocks.requireDashboardAdmin.mockRejectedValueOnce(
        new Error('Admin access required'),
      );

      await expect(isAdmin()).resolves.toBe(false);
    });
  });

  describe('local bypass compatibility', () => {
    it('reports true only for the named local bypass flag', () => {
      vi.stubEnv('LOCAL_AUTH_BYPASS', 'true');

      expect(isAuthDisabled()).toBe(true);
    });

    it('does not activate for the retired AUTH_DISABLED flag', () => {
      vi.stubEnv('AUTH_DISABLED', 'true');

      expect(isAuthDisabled()).toBe(false);
    });

    it('refuses local bypass when a production indicator is present', () => {
      vi.stubEnv('LOCAL_AUTH_BYPASS', 'true');
      vi.stubEnv('NODE_ENV', 'production');

      expect(isAuthDisabled()).toBe(false);
    });
  });
});
