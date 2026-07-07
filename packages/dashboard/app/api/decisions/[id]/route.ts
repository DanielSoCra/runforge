/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — daemon-proxy route for the per-decision detail.
 *
 * The dashboard's only door to the daemon control server's `GET /decisions/:id`
 * (STACK-AC-OPERATOR-SURFACE-API). Reaches the daemon through the shared
 * `daemonFetch` helper (`lib/daemon-fetch.ts`) — never a hand-built URL — and
 * returns the daemon's status + JSON body verbatim.
 *
 * FAIL-SAFE (L2): a daemon non-JSON body maps to 502, a missing `DAEMON_URL`
 * (`DaemonConfigError`) maps to 500, and an unreachable daemon maps to 503 —
 * never a thrown 500 that crashes the page. Viewing detail is a read, so it uses
 * `requireDashboardUser` (any authenticated dashboard operator).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardUser,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonAuthError, DaemonConfigError } from '@/lib/daemon-fetch';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    await requireDashboardUser();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { id } = await ctx.params;

  try {
    const res = await daemonFetch(`/decisions/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return NextResponse.json(
        { error: `Daemon returned non-JSON response (HTTP ${res.status})` },
        { status: 502 },
      );
    }

    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof DaemonConfigError || e instanceof DaemonAuthError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Daemon unreachable' },
      { status: 503 },
    );
  }
}
