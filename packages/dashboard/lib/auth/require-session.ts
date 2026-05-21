import { headers as nextHeaders } from 'next/headers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { resolveLocalAuthBypass } from '../../../auth/src/local-bypass';
import {
  isOperatorRole,
  roleAllows,
  type OperatorRole,
} from '../../../auth/src/roles';
import { readDatabaseUrl } from '../../../db/src/env';
import { teamMembers } from '../../../db/src/schema';
import { getDashboardAuth } from './better-auth';

export class DashboardAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = 'DashboardAuthError';
  }
}

export interface DashboardOperator {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role: OperatorRole;
}

export interface DashboardSession {
  user: DashboardOperator;
  session: unknown;
}

interface SessionPayload {
  user?: {
    id?: string;
    email?: string;
    name?: string;
    image?: string | null;
    role?: unknown;
  };
  session?: unknown;
}

interface DashboardAuthApi {
  api: {
    getSession(input: { headers: Headers }): Promise<SessionPayload | null>;
  };
}

type DashboardMembershipLookupResult =
  | { ok: true; value: { role: OperatorRole } }
  | { ok: false; error: 'not-found' | 'unavailable'; message: string };

interface DashboardMembershipLookup {
  readMembership(userId: string): Promise<DashboardMembershipLookupResult>;
}

interface RequireDashboardSessionOptions {
  headers?: Headers;
  env?: Parameters<typeof resolveLocalAuthBypass>[0];
  auth?: DashboardAuthApi;
  membershipLookup?: DashboardMembershipLookup;
  requiredRole?: OperatorRole;
}

interface DashboardSessionIdentity {
  user: Omit<DashboardOperator, 'role'>;
  session: unknown;
}

const LOCAL_BYPASS_OPERATOR: DashboardSession = {
  user: {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'admin@localhost',
    name: 'Local operator',
    role: 'admin',
  },
  session: { localBypass: true },
};

export async function requireDashboardUser(
  options: Omit<RequireDashboardSessionOptions, 'requiredRole'> = {},
): Promise<DashboardSession> {
  return requireDashboardSession({ ...options, requiredRole: 'viewer' });
}

export async function requireDashboardAdmin(
  options: Omit<RequireDashboardSessionOptions, 'requiredRole'> = {},
): Promise<DashboardSession> {
  return requireDashboardSession({ ...options, requiredRole: 'admin' });
}

export async function isDashboardAdmin(
  options: Omit<RequireDashboardSessionOptions, 'requiredRole'> = {},
): Promise<boolean> {
  try {
    await requireDashboardAdmin(options);
    return true;
  } catch {
    return false;
  }
}

export function getDashboardAuthError(error: unknown): DashboardAuthError {
  if (error instanceof DashboardAuthError) return error;
  const message = error instanceof Error ? error.message : 'Forbidden';
  return new DashboardAuthError(
    message,
    message === 'Unauthorized' ? 401 : 403,
  );
}

async function requireDashboardSession(
  options: RequireDashboardSessionOptions,
): Promise<DashboardSession> {
  const bypass = resolveLocalAuthBypass(options.env);
  if (bypass.enabled) return LOCAL_BYPASS_OPERATOR;

  const requestHeaders = options.headers ?? new Headers(await nextHeaders());
  const auth = options.auth ?? (getDashboardAuth() as DashboardAuthApi);
  const payload = await auth.api.getSession({ headers: requestHeaders });
  const identity = resolveSessionPayload(payload);

  if (!identity) {
    throw new DashboardAuthError('Unauthorized', 401);
  }
  if (identity === 'deny') {
    throw new DashboardAuthError(
      'Access denied — ask an admin to invite you',
      403,
    );
  }

  const membershipLookup =
    options.membershipLookup ?? getDashboardMembershipLookup();
  const membership = await membershipLookup.readMembership(identity.user.id);
  if (!membership.ok) {
    throw new DashboardAuthError(
      membership.error === 'unavailable'
        ? 'Authorization unavailable'
        : 'Access denied — ask an admin to invite you',
      403,
    );
  }

  const session = {
    ...identity,
    user: { ...identity.user, role: membership.value.role },
  };

  const requiredRole = options.requiredRole ?? 'viewer';
  if (!roleAllows(session.user.role, requiredRole)) {
    throw new DashboardAuthError('Admin access required', 403);
  }

  return session;
}

function resolveSessionPayload(
  payload: SessionPayload | null,
): DashboardSessionIdentity | 'deny' | null {
  if (!payload?.user?.id) return null;

  return {
    user: {
      id: payload.user.id,
      email: payload.user.email ?? '',
      name: payload.user.name ?? '',
      image: payload.user.image,
    },
    session: payload.session,
  };
}

type DashboardMembershipDb = ReturnType<
  typeof createDashboardMembershipDbClient
>['db'];

class DashboardDbMembershipLookup implements DashboardMembershipLookup {
  constructor(private readonly db: DashboardMembershipDb) {}

  async readMembership(userId: string): Promise<DashboardMembershipLookupResult> {
    try {
      const [membership] = await this.db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId))
        .limit(1);
      if (!membership) {
        return {
          ok: false,
          error: 'not-found',
          message: `operator membership for user ${userId} was not found`,
        };
      }
      if (!isOperatorRole(membership.role)) {
        return {
          ok: false,
          error: 'not-found',
          message: `operator membership for user ${userId} has invalid role`,
        };
      }
      return { ok: true, value: { role: membership.role } };
    } catch (error) {
      return {
        ok: false,
        error: 'unavailable',
        message: errorMessage(error),
      };
    }
  }
}

let dashboardMembershipLookup: DashboardMembershipLookup | undefined;

function getDashboardMembershipLookup(): DashboardMembershipLookup {
  dashboardMembershipLookup ??= new DashboardDbMembershipLookup(
    getDashboardMembershipDbClient().db,
  );
  return dashboardMembershipLookup;
}

function createDashboardMembershipDbClient() {
  const sql = postgres(readDatabaseUrl(), { max: 4 });
  const db = drizzle(sql, { schema: { teamMembers } });
  return { db, sql };
}

let dashboardMembershipDbClient:
  | ReturnType<typeof createDashboardMembershipDbClient>
  | undefined;

function getDashboardMembershipDbClient() {
  dashboardMembershipDbClient ??= createDashboardMembershipDbClient();
  return dashboardMembershipDbClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
