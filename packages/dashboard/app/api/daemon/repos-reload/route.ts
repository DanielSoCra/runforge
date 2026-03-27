import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function POST() {
  try {
    const supabase = await createClient();
    await requireAdmin(supabase);
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }

  try {
    const res = await daemonFetch('/repos/reload', { method: 'POST' });
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
