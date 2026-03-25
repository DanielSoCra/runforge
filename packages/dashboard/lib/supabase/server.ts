import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types';
import { getSupabaseEnv } from './env';
import { isAuthDisabled } from '@/lib/auth';

export async function createClient() {
  const { url, anonKey } = getSupabaseEnv();

  // In AUTH_DISABLED mode, use service role key to bypass RLS
  // (no user session exists, so anon key returns empty results)
  if (isAuthDisabled() && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createSupabaseClient<Database>(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const cookieStore = await cookies();
  return createServerClient<Database>(
    url,
    anonKey,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {} // Server Component — cookies are read-only; middleware handles refresh
        },
      },
    }
  );
}
