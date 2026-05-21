import { getDashboardAuth } from '@/lib/auth/better-auth';
import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const authResponse = await getDashboardAuth().handler(new Request(
    new URL('/api/auth/sign-in/social', request.url),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        callbackURL: '/',
        errorCallbackURL: '/login?error=oauth_failed',
      }),
    },
  ));

  if (!authResponse.ok) {
    return loginRedirect('/login?error=oauth_failed', request);
  }

  const redirectTarget = await readAuthRedirectTarget(authResponse);
  if (!redirectTarget) {
    return loginRedirect('/login?error=oauth_failed', request);
  }

  return redirectWithAuthCookies(redirectTarget, authResponse, request);
}

async function readAuthRedirectTarget(response: Response): Promise<string | null> {
  const headerTarget = response.headers.get('location');
  if (headerTarget) return headerTarget;

  const body = await response
    .clone()
    .json()
    .catch(() => null) as { url?: unknown } | null;
  return typeof body?.url === 'string' && body.url ? body.url : null;
}

function redirectWithAuthCookies(
  target: string,
  source: Response,
  request: NextRequest,
) {
  const response = loginRedirect(target, request);
  for (const cookie of readSetCookies(source.headers)) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

function loginRedirect(target: string, request: NextRequest) {
  return NextResponse.redirect(new URL(target, request.url), 303);
}

function readSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = withGetSetCookie.getSetCookie?.();
  if (cookies?.length) return cookies;

  const cookie = headers.get('set-cookie');
  return cookie ? [cookie] : [];
}
