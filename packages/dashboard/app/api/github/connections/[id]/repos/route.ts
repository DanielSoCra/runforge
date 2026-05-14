import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireAdmin } from '@/lib/auth';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  try {
    await requireAdmin(supabase);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Forbidden';
    const status = message === 'Unauthorized' ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }

  const { id } = await params;
  const org = req.nextUrl.searchParams.get('org');
  if (!org) return NextResponse.json({ error: 'Missing org param' }, { status: 400 });
  if (!SAFE_PATTERN.test(org)) return NextResponse.json({ error: 'Invalid org param' }, { status: 400 });

  // Decrypt token — service role required
  const service = createServiceClient();
  const { data: token, error: tokenErr } = await service.rpc('decrypt_github_token', {
    p_connection_id: id,
  });
  if (tokenErr || !token) return NextResponse.json({ error: 'Could not retrieve token' }, { status: 500 });

  // Determine if this is the personal account (org matches github_login)
  const { data: conn, error: connErr } = await supabase
    .from('github_connections')
    .select('github_login')
    .eq('id', id)
    .single();
  if (connErr) return NextResponse.json({ error: 'Database error' }, { status: 500 });

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
