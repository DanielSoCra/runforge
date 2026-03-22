/**
 * Validates and returns Supabase environment variables.
 * Throws a descriptive error if either is missing, rather than
 * letting createServerClient/createBrowserClient fail cryptically.
 */
export function getSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL environment variable. ' +
      'Set it in .env.local or your deployment environment.'
    );
  }
  if (!anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable. ' +
      'Set it in .env.local or your deployment environment.'
    );
  }

  return { url, anonKey };
}
