import { NextResponse } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonAuthError, DaemonConfigError } from '@/lib/daemon-fetch';

export async function POST() {
  try {
    await requireDashboardAdmin();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const res = await daemonFetch('/issues/scan', { method: 'POST' });
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
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
