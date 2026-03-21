import { createClient } from '@/lib/supabase/server';
import { getOrigin } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { type NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const origin = getOrigin(request);

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
