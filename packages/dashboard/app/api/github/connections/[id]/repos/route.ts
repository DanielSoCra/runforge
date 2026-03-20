import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const org = req.nextUrl.searchParams.get('org');
  if (!org) return NextResponse.json({ error: 'Missing org param' }, { status: 400 });

  // Decrypt token — service role required
  const service = createServiceClient();
  const { data: token, error: tokenErr } = await service.rpc('decrypt_github_token', {
    p_connection_id: id,
  });
  if (tokenErr || !token) return NextResponse.json({ error: 'Could not retrieve token' }, { status: 500 });

  // Determine if this is the personal account (org matches github_login)
  const { data: conn } = await supabase
    .from('github_connections')
    .select('github_login')
    .eq('id', id)
    .single();

  const ghHeaders = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const endpoint = conn?.github_login === org
    ? `https://api.github.com/user/repos?per_page=100&type=owner`
    : `https://api.github.com/orgs/${org}/repos?per_page=100&type=all`;

  const res = await fetch(endpoint, { headers: ghHeaders });
  if (!res.ok) return NextResponse.json({ error: 'GitHub API error' }, { status: 502 });

  const ghRepos = await res.json() as Array<{ full_name: string; name: string; owner: { login: string }; private: boolean }>;
  return NextResponse.json(
    ghRepos.map((r) => ({ owner: r.owner.login, name: r.name, full_name: r.full_name, private: r.private }))
  );
}
