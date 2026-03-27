import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function GET() {
  try {
    const supabase = await createClient();
    await requireUser(supabase);
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: e.message }, { status });
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
