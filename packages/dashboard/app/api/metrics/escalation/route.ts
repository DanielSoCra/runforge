/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — daemon-proxy route for escalation metrics.
 *
 * The dashboard's only door to the daemon control server's `GET /metrics/escalation`
 * (STACK-AC-CONTROL-PLANE). Reaches the daemon through the shared `daemonFetch`
 * helper (`lib/daemon-fetch.ts`).
 *
 * FAIL-SAFE (L2): a daemon 503 / unreachable / DaemonConfigError / non-JSON body
 * maps to a DEGRADED response shape the UI can render calmly
 * (`{ weeks: [], unavailable: true }`), NOT a thrown error.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardUser,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonAuthError, DaemonConfigError } from '@/lib/daemon-fetch';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireDashboardUser();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const search = request.nextUrl.searchParams.toString();
    const path = `/metrics/escalation${search ? `?${search}` : ''}`;
    const res = await daemonFetch(path, { cache: 'no-store' });
    const json = await res.json().catch(() => null);
    if (!res.ok || json === null) {
      return NextResponse.json({ weeks: [], unavailable: true });
    }
    const weeks = Array.isArray(json.weeks) ? json.weeks : [];
    const deployments = Array.isArray(json.deployments) ? json.deployments : undefined;
    return NextResponse.json({
      weeks,
      ...(deployments !== undefined ? { deployments } : {}),
      ...(json.unavailable === true ? { unavailable: true } : {}),
    });
  } catch (e) {
    if (e instanceof DaemonConfigError || e instanceof DaemonAuthError) {
      return NextResponse.json({ weeks: [], unavailable: true });
    }
    return NextResponse.json({ weeks: [], unavailable: true });
  }
}
