import { headers as nextHeaders } from 'next/headers';

import { resolveLocalAuthBypass } from '../../../auth/src/local-bypass';
import {
  isOperatorRole,
  roleAllows,
  type OperatorRole,
} from '../../../auth/src/roles';
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

interface RequireDashboardSessionOptions {
  headers?: Headers;
  env?: Parameters<typeof resolveLocalAuthBypass>[0];
  auth?: DashboardAuthApi;
  requiredRole?: OperatorRole;
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
  const session = resolveSessionPayload(payload);

  if (!session) {
    throw new DashboardAuthError('Unauthorized', 401);
  }
  if (session === 'deny') {
    throw new DashboardAuthError(
      'Access denied — ask an admin to invite you',
      403,
    );
  }

  const requiredRole = options.requiredRole ?? 'viewer';
  if (!roleAllows(session.user.role, requiredRole)) {
    throw new DashboardAuthError('Admin access required', 403);
  }

  return session;
}

function resolveSessionPayload(
  payload: SessionPayload | null,
): DashboardSession | 'deny' | null {
  if (!payload?.user?.id) return null;
  if (!isOperatorRole(payload.user.role)) return 'deny';

  return {
    user: {
      id: payload.user.id,
      email: payload.user.email ?? '',
      name: payload.user.name ?? '',
      image: payload.user.image,
      role: payload.user.role,
    },
    session: payload.session,
  };
}
