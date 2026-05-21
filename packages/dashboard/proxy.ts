import { type NextRequest, NextResponse } from 'next/server';
import { resolveLocalAuthBypass } from '../auth/src/local-bypass';

const BETTER_AUTH_SESSION_COOKIES = [
  'auto-claude.session_token',
  '__Secure-auto-claude.session_token',
];

export async function proxy(request: NextRequest) {
  if (resolveLocalAuthBypass().enabled || isPublicPath(request)) {
    return NextResponse.next();
  }

  if (hasBetterAuthSessionCookie(request)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

function isPublicPath(request: NextRequest): boolean {
  const pathname = request.nextUrl.pathname;
  return pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/api/');
}

function hasBetterAuthSessionCookie(request: NextRequest): boolean {
  return BETTER_AUTH_SESSION_COOKIES.some((name) =>
    request.cookies.has(name),
  );
}
