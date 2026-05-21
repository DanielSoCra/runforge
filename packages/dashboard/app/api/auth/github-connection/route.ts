import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
} from '@/lib/auth/require-session';

export async function GET(request: NextRequest) {
  try {
    await requireDashboardAdmin();
  } catch (e) {
    const authError = getDashboardAuthError(e);
    return NextResponse.json(
      { error: authError.message },
      { status: authError.status },
    );
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: 'GitHub OAuth not configured' }, { status: 500 });

  const state = crypto.randomUUID();
  const origin = getOAuthOrigin(request);

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

function getOAuthOrigin(request: Request): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL environment variable is required in production',
    );
  }
  return new URL(request.url).origin;
}
