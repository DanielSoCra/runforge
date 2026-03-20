import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: member } = await supabase.from('team_members')
    .select('role').eq('user_id', user.id).single();
  if (member?.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const res = await fetch(`${process.env.DAEMON_URL}/repos/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
