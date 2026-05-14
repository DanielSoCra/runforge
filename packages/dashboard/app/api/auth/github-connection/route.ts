import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrigin, requireAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  try {
    await requireAdmin(supabase);
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: 'GitHub OAuth not configured' }, { status: 500 });

  const state = crypto.randomUUID();
  const origin = getOrigin(request);

  const callbackUrl = `${origin}/api/auth/github-connection/callback`;
  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', clientId);
  githubUrl.searchParams.set('redirect_uri', callbackUrl);
  githubUrl.searchParams.set('scope', 'repo read:org read:user');
  githubUrl.searchParams.set('state', state);

  const response = NextResponse.redirect(githubUrl.toString());
  response.cookies.set('gh_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return response;
}
