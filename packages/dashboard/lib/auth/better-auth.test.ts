import { describe, expect, it } from 'vitest';

import { buildDashboardAuthOptions, type DashboardAuthDb } from './better-auth';

describe('buildDashboardAuthOptions', () => {
  it('configures Better Auth with the app-owned auth tables', () => {
    const options = buildDashboardAuthOptions({
      db: {} as DashboardAuthDb,
      env: {
        BETTER_AUTH_URL: 'https://dashboard.example.test',
        BETTER_AUTH_SECRET: 'test-secret',
      },
    });

    expect(options.appName).toBe('Runforge');
    expect(options.baseURL).toBe('https://dashboard.example.test');
    expect(options.secret).toBe('test-secret');
    expect(typeof options.database).toBe('function');
    expect(options.advanced?.cookiePrefix).toBe('runforge');
    expect(options.advanced?.database?.generateId).toBe('uuid');
    expect(options.session?.expiresIn).toBe(60 * 60 * 24 * 7);
    expect(options.session?.updateAge).toBe(60 * 60 * 24);
    expect(options.plugins).toHaveLength(1);
  });

  it('exposes the app-owned role field on Better Auth users', () => {
    const options = buildDashboardAuthOptions({
      db: {} as DashboardAuthDb,
      env: { BETTER_AUTH_SECRET: 'test-secret' },
    });

    expect(options.user?.additionalFields?.role).toEqual({
      type: 'string',
      required: true,
      input: false,
      returned: true,
      defaultValue: 'viewer',
    });
  });

  it('configures GitHub login only when both Better Auth OAuth secrets exist', () => {
    const options = buildDashboardAuthOptions({
      db: {} as DashboardAuthDb,
      env: {
        BETTER_AUTH_SECRET: 'test-secret',
        BETTER_AUTH_GITHUB_CLIENT_ID: 'client-id',
        BETTER_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
      },
    });

    expect(options.socialProviders).toEqual({
      github: expect.objectContaining({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        mapProfileToUser: expect.any(Function),
      }),
    });
  });

  it('maps GitHub login names into operator handles for invitation matching', async () => {
    const options = buildDashboardAuthOptions({
      db: {} as DashboardAuthDb,
      env: {
        BETTER_AUTH_SECRET: 'test-secret',
        BETTER_AUTH_GITHUB_CLIENT_ID: 'client-id',
        BETTER_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
      },
    });

    const github = options.socialProviders?.github as {
      mapProfileToUser(profile: { login: string; name: string }): { name: string };
    };

    expect(github.mapProfileToUser({ login: 'daniel', name: 'the Operator' })).toEqual({
      name: 'daniel',
    });
  });

  it('reconciles operator membership whenever Better Auth creates a session', () => {
    const options = buildDashboardAuthOptions({
      db: {} as DashboardAuthDb,
      env: { BETTER_AUTH_SECRET: 'test-secret' },
    });

    expect(options.databaseHooks?.session?.create?.after).toEqual(
      expect.any(Function),
    );
  });

  it('fails closed when GitHub login configuration is partial', () => {
    expect(() =>
      buildDashboardAuthOptions({
        db: {} as DashboardAuthDb,
        env: {
          BETTER_AUTH_SECRET: 'test-secret',
          BETTER_AUTH_GITHUB_CLIENT_ID: 'client-id',
        },
      }),
    ).toThrow(
      /BETTER_AUTH_GITHUB_CLIENT_ID and BETTER_AUTH_GITHUB_CLIENT_SECRET/,
    );
  });
});
