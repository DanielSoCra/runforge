import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
} from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireDashboardAdmin();
  } catch (e) {
    const authError = getDashboardAuthError(e);
    return NextResponse.json(
      { error: authError.message },
      { status: authError.status },
    );
  }

  const { id } = await params;
  const org = req.nextUrl.searchParams.get('org');
  if (!org) return NextResponse.json({ error: 'Missing org param' }, { status: 400 });
  if (!SAFE_PATTERN.test(org)) return NextResponse.json({ error: 'Invalid org param' }, { status: 400 });

  const credential =
    await getDashboardStores().githubConnections.readCredential(id);
  if (!credential.ok) {
    const error =
      credential.error === 'denied'
        ? 'Could not retrieve token'
        : 'Database error';
    return NextResponse.json({ error }, { status: 500 });
  }

  const ghHeaders = {
    Authorization: `Bearer ${credential.value.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const endpoint = credential.value.githubLogin === org
    ? `https://api.github.com/user/repos?per_page=100&type=owner`
    : `https://api.github.com/orgs/${org}/repos?per_page=100&type=all`;

  const res = await fetch(endpoint, { headers: ghHeaders });
  if (!res.ok) return NextResponse.json({ error: 'GitHub API error' }, { status: 502 });

  const ghRepos = await res.json() as Array<{ full_name: string; name: string; owner: { login: string }; private: boolean }>;
  return NextResponse.json(
    ghRepos.map((r) => ({ owner: r.owner.login, name: r.name, full_name: r.full_name, private: r.private }))
  );
}
