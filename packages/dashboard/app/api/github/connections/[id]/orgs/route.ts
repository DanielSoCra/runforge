import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  try {
    await requireAdmin(supabase);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const { data: orgs, error } = await supabase
    .from('github_orgs')
    .select('id, login, name, avatar_url, is_selected')
    .eq('connection_id', id)
    .order('login');

  if (error) {
    console.error('[orgs] Failed to fetch orgs for connection:', error);
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 });
  }
  return NextResponse.json(orgs ?? []);
}
