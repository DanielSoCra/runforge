import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { data: orgs, error } = await supabase
    .from('github_orgs')
    .select('id, login, name, avatar_url, is_selected')
    .eq('connection_id', id)
    .order('login');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(orgs ?? []);
}
