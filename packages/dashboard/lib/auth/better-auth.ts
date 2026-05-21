import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  resolveBetterAuthBaseUrl,
  resolveBetterAuthSecret,
  type BetterAuthEnv,
} from '../../../auth/src/better-auth-config';
import type { OperatorRole } from '../../../auth/src/roles';
import { readDatabaseUrl } from '../../../db/src/env';
import * as schema from '../../../db/src/schema';

const {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  invitations,
  teamMembers,
} = schema;

const OPERATOR_MEMBERSHIP_LOCK_NAME = 'auto_claude_operator_membership';

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
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            if (session?.userId) {
              await reconcileOperatorAccess(options.db, session.userId);
            }
          },
        },
      },
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
  return {
    github: {
      clientId,
      clientSecret,
      mapProfileToUser: (profile: GitHubLoginProfile) => ({
        name: profile.login || profile.name || '',
      }),
    },
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

interface GitHubLoginProfile {
  login?: string | null;
  name?: string | null;
}

interface OperatorAccessUser {
  id: string;
  email: string;
  name: string;
}

async function reconcileOperatorAccess(
  db: DashboardAuthDb,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      postgresLockStatement(OPERATOR_MEMBERSHIP_LOCK_NAME),
    );

    const [existingMembership] = await tx
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .limit(1);
    if (existingMembership) return;

    const [user] = await tx
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .limit(1);
    if (!user) return;

    const [membershipCount] = await tx
      .select({ value: count() })
      .from(teamMembers);
    if ((membershipCount?.value ?? 0) === 0) {
      await grantOperatorAccess(tx, user.id, 'admin');
      return;
    }

    const invitation = await findPendingInvitation(tx, user);
    if (!invitation) return;

    await grantOperatorAccess(tx, user.id, invitation.role);
    await tx
      .update(invitations)
      .set({ status: 'accepted' })
      .where(eq(invitations.id, invitation.id));
  });
}

function postgresLockStatement(lockName: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${lockName}))`;
}

async function grantOperatorAccess(
  tx: Parameters<Parameters<DashboardAuthDb['transaction']>[0]>[0],
  userId: string,
  role: OperatorRole,
) {
  await tx
    .insert(teamMembers)
    .values({ userId, role })
    .onConflictDoNothing({ target: teamMembers.userId });

  await tx
    .update(authUsers)
    .set({ role, updatedAt: new Date() })
    .where(eq(authUsers.id, userId));
}

async function findPendingInvitation(
  tx: Parameters<Parameters<DashboardAuthDb['transaction']>[0]>[0],
  user: OperatorAccessUser,
): Promise<{ id: string; role: OperatorRole } | null> {
  const candidates = new Set(
    [user.name, user.email].map(normalizeAccessHandle).filter(Boolean),
  );
  if (candidates.size === 0) return null;

  const rows = await tx
    .select({
      id: invitations.id,
      providerHandle: invitations.providerHandle,
      role: invitations.role,
    })
    .from(invitations)
    .where(
      and(eq(invitations.status, 'pending'), gt(invitations.expiresAt, new Date())),
    );

  return (
    rows.find((row) => candidates.has(normalizeAccessHandle(row.providerHandle)))
    ?? null
  );
}

function normalizeAccessHandle(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}
