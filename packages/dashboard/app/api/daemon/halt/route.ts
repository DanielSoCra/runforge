/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — emergency halt proxy.
 *
 * Mirrors the pause/resume proxy shape (`requireDashboardAdmin()` → forward →
 * verbatim status/body). Adds the P3.6 shared-secret design point: when the
 * DASHBOARD env `AUTO_CLAUDE_CONTROL_TOKEN` is set, it is forwarded as
 * `Authorization: Bearer <token>` to the daemon's POST /halt. When unset, no
 * Authorization header is sent — halting is the safe direction, so a missing
 * local token does not block an emergency stop.
 *
 * The daemon itself enforces the Bearer check when its own
 * AUTO_CLAUDE_CONTROL_TOKEN is set; this route only forwards what the dashboard
 * has configured.
 */
import { NextResponse } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function POST() {
  try {
    await requireDashboardAdmin();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const token = process.env.AUTO_CLAUDE_CONTROL_TOKEN;
    const res = await daemonFetch('/halt', {
      method: 'POST',
      headers:
        token !== undefined && token !== ''
          ? { Authorization: `Bearer ${token}` }
          : undefined,
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
    if (e instanceof DaemonConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
