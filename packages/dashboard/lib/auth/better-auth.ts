import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  resolveBetterAuthBaseUrl,
  resolveBetterAuthSecret,
  type BetterAuthEnv,
} from '../../../auth/src/better-auth-config';
import { readDatabaseUrl } from '../../../db/src/env';
import * as schema from '../../../db/src/schema';

const { authAccounts, authSessions, authUsers, authVerifications } = schema;

export interface DashboardAuthEnv extends BetterAuthEnv {
  BETTER_AUTH_GITHUB_CLIENT_ID?: string;
  BETTER_AUTH_GITHUB_CLIENT_SECRET?: string;
}

export interface DashboardAuthOptions {
  db?: DashboardAuthDb;
  env?: DashboardAuthEnv;
}

export type DashboardAuthDb = ReturnType<typeof createDashboardDbClient>['db'];

export function buildDashboardAuthOptions(
  options: Required<Pick<DashboardAuthOptions, 'db'>> &
    Pick<DashboardAuthOptions, 'env'>,
): BetterAuthOptions {
  const env = options.env ?? (process.env as DashboardAuthEnv);
  const socialProviders = readGithubLoginProvider(env);

  return {
    appName: 'Auto-Claude',
    baseURL: resolveBetterAuthBaseUrl(env),
    secret: resolveBetterAuthSecret(env),
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
      transaction: true,
    }),
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: true,
          input: false,
          returned: true,
          defaultValue: 'viewer',
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      cookiePrefix: 'auto-claude',
      database: { generateId: 'uuid' },
    },
    ...(socialProviders ? { socialProviders } : {}),
    plugins: [nextCookies()],
  };
}

export function createDashboardAuth(options: DashboardAuthOptions = {}) {
  const db = options.db ?? getDashboardDbClient().db;
  return betterAuth(buildDashboardAuthOptions({ db, env: options.env }));
}

let dashboardAuth: ReturnType<typeof createDashboardAuth> | undefined;

export function getDashboardAuth() {
  dashboardAuth ??= createDashboardAuth();
  return dashboardAuth;
}

function createDashboardDbClient() {
  const sql = postgres(readDatabaseUrl(), { max: 14 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let dashboardDbClient: ReturnType<typeof createDashboardDbClient> | undefined;

function getDashboardDbClient() {
  dashboardDbClient ??= createDashboardDbClient();
  return dashboardDbClient;
}

function readGithubLoginProvider(env: DashboardAuthEnv) {
  const clientId = readNonEmpty(env.BETTER_AUTH_GITHUB_CLIENT_ID);
  const clientSecret = readNonEmpty(env.BETTER_AUTH_GITHUB_CLIENT_SECRET);
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      'BETTER_AUTH_GITHUB_CLIENT_ID and BETTER_AUTH_GITHUB_CLIENT_SECRET must be set together',
    );
  }
  return { github: { clientId, clientSecret } };
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
