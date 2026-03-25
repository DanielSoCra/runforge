import { createClient } from '@/lib/supabase/server';

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Returns true when auth is disabled (private network, single operator).
 *
 * SECURITY: Refuses AUTH_DISABLED=true in production UNLESS
 * AUTH_DISABLED_CONFIRM_PRODUCTION=true is also set. This prevents accidental
 * deployment without authentication while allowing intentional private-network
 * deployments (e.g., Mac Mini on LAN).
 */
export function isAuthDisabled(): boolean {
  if (process.env.AUTH_DISABLED !== 'true') return false;
  if (process.env.NODE_ENV === 'production') {
    return process.env.AUTH_DISABLED_CONFIRM_PRODUCTION === 'true';
  }
  return true;
}

/** Synthetic admin user for AUTH_DISABLED mode. */
const SYNTHETIC_ADMIN = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'admin@localhost',
  role: 'authenticated',
} as const;

/**
 * Returns a safe origin for OAuth redirects.
 *
 * SECURITY: Never trusts X-Forwarded-Host/Proto headers — an attacker can
 * inject arbitrary values to redirect OAuth callbacks to a controlled domain.
 * NEXT_PUBLIC_SITE_URL must be set explicitly; in development we fall back to request.url.
 */
export function getOrigin(request?: Request): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    // Strip trailing slash for consistency
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_SITE_URL environment variable is required in production');
  }
  // Development only: derive from request.url (localhost origin, not headers)
  if (request) {
    const url = new URL(request.url);
    return url.origin;
  }
  return 'http://localhost:3000';
}

export async function requireAdmin(supabase: SupabaseClient) {
  if (isAuthDisabled()) return SYNTHETIC_ADMIN as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: member, error } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('[auth] team_members query failed:', error.message);
  }
  if (member?.role !== 'admin') throw new Error('Admin access required');
  return user;
}

/**
 * Require any authenticated user (admin or viewer).
 * Throws if the user is not signed in or has no team membership.
 * Unlike requireAdmin, this does NOT check the role — any team member is allowed.
 */
export async function requireUser(supabase: SupabaseClient) {
  if (isAuthDisabled()) return SYNTHETIC_ADMIN as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: member, error } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('[auth] team_members query failed:', error.message);
  }
  if (!member) throw new Error('Access denied — ask an admin to invite you');
  return user;
}

/** Returns true if the current user is an admin. Never throws. */
export async function isAdmin(supabase: SupabaseClient): Promise<boolean> {
  if (isAuthDisabled()) return true;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: member, error } = await supabase.from('team_members')
      .select('role')
      .eq('user_id', user.id)
      .single();
    if (error && error.code !== 'PGRST116') {
      console.error('[auth] team_members query failed:', error.message);
    }
    return member?.role === 'admin';
  } catch {
    return false;
  }
}
