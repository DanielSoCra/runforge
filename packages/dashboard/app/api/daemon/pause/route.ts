import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export async function POST() {
  try {
    const supabase = await createClient();
    await requireAdmin(supabase);
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/pause`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'dashboard' },
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
