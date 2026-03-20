// Next.js 16.x explicitly supports `proxy.ts` as the auth middleware entry point.
// `PROXY_FILENAME = 'proxy'` is defined in next/dist/esm/lib/constants.js alongside
// MIDDLEWARE_FILENAME — both are auto-loaded. No separate middleware.ts is needed.
import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
