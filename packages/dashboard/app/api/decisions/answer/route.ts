/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — daemon-proxy route for the operator ANSWER.
 *
 * The dashboard's only door to the daemon control server's
 * `POST /decisions/:id/answer` (STACK-AC-OPERATOR-SURFACE-API, slice 7c). The
 * client posts `{ decision_id, chosen_option }`; this handler:
 *
 *   (1) guards with the dashboard auth + CSRF the other mutation proxies use
 *       (`requireDashboardUser` + the `X-Requested-By` header `daemonFetch`
 *       injects) — rejects unauthenticated with the auth error's status;
 *   (2) forwards to the daemon at `/decisions/<percent-encoded id>/answer` via the
 *       shared `daemonFetch` helper (NEVER a hand-built URL), body
 *       `{ chosen_option }`, method POST;
 *   (3) returns the daemon's status + JSON body verbatim (200 answered, 400
 *       malformed/unsupported option, 404 unknown, 409 not-answerable, 503 index
 *       unavailable);
 *   (4) maps an unreachable daemon / `DaemonConfigError` / non-JSON body to a
 *       DEGRADED error shape the UI can show calmly (503 / 500 / 502 — mirroring
 *       the sibling mutation proxies), never a thrown 500 that crashes the page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardUser,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireDashboardUser();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  let body: { decision_id?: unknown; chosen_option?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const decisionId = typeof body.decision_id === 'string' ? body.decision_id : '';
  const chosenOption = typeof body.chosen_option === 'string' ? body.chosen_option : '';

  try {
    const res = await daemonFetch(
      `/decisions/${encodeURIComponent(decisionId)}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chosen_option: chosenOption }),
      },
    );

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
    if (e instanceof DaemonConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Daemon unreachable' },
      { status: 503 },
    );
  }
}
