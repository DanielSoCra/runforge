import { createClient } from '@/lib/supabase/server';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code) return NextResponse.redirect(`${origin}/login?error=no_code`);

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !user) return NextResponse.redirect(`${origin}/login?error=auth_failed`);

  // Bootstrap: first user → admin; invited users → their role; others → denied
  const providerHandle = user.user_metadata?.user_name ?? user.email ?? '';
  const { data: result } = await supabase.rpc('bootstrap_user_access', {
    p_user_id: user.id,
    p_provider_handle: providerHandle,
  });

  if (result === 'denied') {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=access_denied`);
  }

  return NextResponse.redirect(`${origin}/`);
}
