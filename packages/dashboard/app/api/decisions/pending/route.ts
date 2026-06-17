/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — daemon-proxy route for the decisions inbox.
 *
 * The dashboard's only door to the daemon control server's `GET /decisions/pending`
 * (STACK-AC-OPERATOR-SURFACE-API). Reaches the daemon through the shared
 * `daemonFetch` helper (`lib/daemon-fetch.ts`) — never a hand-built URL — and
 * returns the ranked `RankedListItem[]` to the Surface Client.
 *
 * FAIL-SAFE (L2): a daemon 503 / unreachable / DaemonConfigError / non-JSON body
 * maps to a DEGRADED response shape the UI can render calmly
 * (`{ items: [], unavailable: true }`), NOT a thrown error — mirroring
 * `app/api/daemon/status/route.ts`. The client "never treats 503 as data loss".
 *
 * SCOPE (7b): the READ inbox list only. The `GET /decisions/:id` detail proxy and
 * the operator ANSWER route are deferred follow-ups.
 *
 * STUB: not implemented — Kimi implements per the work-order. The body throws so
 * the RED route test fails for the right reason while the dashboard typechecks.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardUser,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireDashboardUser();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const search = request.nextUrl.searchParams.toString();
    const path = `/decisions/pending${search ? `?${search}` : ''}`;
    const res = await daemonFetch(path, { cache: 'no-store' });
    const json = await res.json().catch(() => null);
    if (!res.ok || json === null) {
      return NextResponse.json({ items: [], unavailable: true });
    }
    const items = Array.isArray(json) ? json : (json.items ?? []);
    return NextResponse.json({ items });
  } catch (e) {
    if (e instanceof DaemonConfigError) {
      return NextResponse.json({ items: [], unavailable: true });
    }
    return NextResponse.json({ items: [], unavailable: true });
  }
}
