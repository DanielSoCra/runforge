import {
  requireDashboardAdmin,
  requireDashboardUser,
} from '@/lib/auth/require-session';
import { resolveLocalAuthBypass } from '../../auth/src/local-bypass';

/**
 * Legacy compatibility for callers that still import the old auth module.
 * New code should use lib/auth/require-session directly.
 */
export function isAuthDisabled(): boolean {
  return resolveLocalAuthBypass().enabled;
}

/**
 * Returns a safe origin for OAuth redirects.
 *
 * SECURITY: Never trusts X-Forwarded-Host/Proto headers. NEXT_PUBLIC_SITE_URL
 * must be set explicitly in production; development may derive from request.url.
 */
export function getOrigin(request?: Request): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL environment variable is required in production',
    );
  }
  if (request) {
    const url = new URL(request.url);
    return url.origin;
  }
  return 'http://localhost:3000';
}

export async function requireAdmin() {
  const session = await requireDashboardAdmin();
  return session.user;
}

export async function requireUser() {
  const session = await requireDashboardUser();
  return session.user;
}

export async function isAdmin(): Promise<boolean> {
  try {
    await requireDashboardAdmin();
    return true;
  } catch {
    return false;
  }
}
