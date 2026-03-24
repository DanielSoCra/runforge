import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { daemonFetch, DaemonConfigError } from '@/lib/daemon-fetch';

export async function POST() {
  const supabase = await createClient();
  try { await requireAdmin(supabase); } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const res = await daemonFetch('/remote-control/restart', { method: 'POST' });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof DaemonConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
