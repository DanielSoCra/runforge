import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function POST() {
  const supabase = await createClient();
  // SITE_URL is a plain (non-NEXT_PUBLIC_) env var read at runtime.
  // Fall back to X-Forwarded-* headers set by Caddy if SITE_URL is not set.
  const h = await headers();
  const origin = process.env.SITE_URL
    ?? `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('x-forwarded-host') ?? h.get('host') ?? ''}`;

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
