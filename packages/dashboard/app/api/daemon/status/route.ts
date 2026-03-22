import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isAuthDisabled } from '@/lib/auth';

export async function GET() {
  // Auth check — require authenticated user to view daemon status
  if (!isAuthDisabled()) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
