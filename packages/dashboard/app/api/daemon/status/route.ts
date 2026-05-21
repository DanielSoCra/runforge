import { NextResponse } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardUser,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function GET() {
  try {
    await requireDashboardUser();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const res = await daemonFetch('/status', {
      signal: AbortSignal.timeout(3000),
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
    if (e instanceof DaemonConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { state: 'offline', active_runs: 0, version: 'unknown' },
      { status: 503 },
    );
  }
}
