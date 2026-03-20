import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function POST() {
  const supabase = await createClient();
  // Build the callback URL from forwarded headers set by Caddy.
  // NEXT_PUBLIC_* vars are inlined at build time (no env file in Docker build),
  // so we derive the origin from the live request instead.
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const origin = `${proto}://${host}`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: `${origin}/auth/callback`,
    },
  });
  if (error || !data.url) {
    redirect('/login?error=oauth_failed');
  }
  redirect(data.url);
}
