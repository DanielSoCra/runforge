import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';

export async function GET() {
  // Auth check — require team member to view daemon status (#276)
  try {
    const supabase = await createClient();
    await requireUser(supabase);
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/status`, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { state: 'offline', active_runs: 0, version: 'unknown' },
      { status: 503 }
    );
  }
}
