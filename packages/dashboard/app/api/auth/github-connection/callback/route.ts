import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const origin = process.env.SITE_URL
    ?? `${request.headers.get('x-forwarded-proto') ?? 'https'}://${request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''}`;
  const settingsUrl = `${origin}/settings`;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const storedState = request.cookies.get('gh_oauth_state')?.value;

  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.redirect(`${settingsUrl}?error=invalid_state`);
  }

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!tokenRes.ok) return NextResponse.redirect(`${settingsUrl}?error=token_exchange_failed`);

  const { access_token: token, scope } = await tokenRes.json() as { access_token?: string; scope?: string };
  if (!token) return NextResponse.redirect(`${settingsUrl}?error=token_exchange_failed`);

  // Fetch GitHub user info and orgs
  const ghHeaders = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const [userRes, orgsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: ghHeaders }),
    fetch('https://api.github.com/user/orgs?per_page=100', { headers: ghHeaders }),
  ]);
  if (!userRes.ok) return NextResponse.redirect(`${settingsUrl}?error=github_api_failed`);

  const ghUser = await userRes.json() as { login: string; name?: string; avatar_url?: string; id: number };
  const ghOrgs = orgsRes.ok ? (await orgsRes.json() as Array<{ id: number; login: string; name?: string; avatar_url?: string }>) : [];

  // Store connection via SECURITY DEFINER function
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${settingsUrl}?error=not_authenticated`);

  const { data: member } = await supabase.from('team_members').select('role').eq('user_id', user.id).single();
  if (member?.role !== 'admin') return NextResponse.redirect(`${settingsUrl}?error=not_admin`);

  const { data: connectionId, error: connErr } = await supabase.rpc('store_github_connection', {
    p_display_name: `${ghUser.login} (personal)`,
    p_github_login: ghUser.login,
    p_avatar_url: ghUser.avatar_url ?? '',
    p_connection_type: 'oauth_token',
    p_plaintext_token: token,
    p_scopes: scope ?? '',
  });
  if (connErr) return NextResponse.redirect(`${settingsUrl}?error=store_failed`);

  // Upsert orgs (personal account + orgs)
  const allOrgs = [
    { connection_id: connectionId, github_id: ghUser.id, login: ghUser.login, name: ghUser.name ?? ghUser.login, avatar_url: ghUser.avatar_url ?? null },
    ...ghOrgs.map((o) => ({ connection_id: connectionId, github_id: o.id, login: o.login, name: o.name ?? o.login, avatar_url: o.avatar_url ?? null })),
  ];
  await supabase.from('github_orgs').upsert(allOrgs, { onConflict: 'connection_id,github_id' });

  const response = NextResponse.redirect(settingsUrl);
  response.cookies.delete('gh_oauth_state');
  return response;
}
