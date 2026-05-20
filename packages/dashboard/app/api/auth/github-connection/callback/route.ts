import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
} from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';

export async function GET(request: NextRequest) {
  const origin = getOAuthOrigin(request);
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

  const session = await requireDashboardAdmin().catch((error) => {
    const authError = getDashboardAuthError(error);
    return authError.status === 401 ? 'not_authenticated' : 'not_admin';
  });
  if (session === 'not_authenticated' || session === 'not_admin') {
    return NextResponse.redirect(`${settingsUrl}?error=${session}`);
  }

  const storeResult =
    await getDashboardStores().githubConnections.storeOAuthConnection(
      {
        displayName: `${ghUser.login} (personal)`,
        githubLogin: ghUser.login,
        avatarUrl: ghUser.avatar_url ?? null,
        connectionType: 'oauth_token',
        scopes: scope ?? '',
        createdBy: session.user.id,
        organizations: [
          {
            githubId: ghUser.id,
            login: ghUser.login,
            name: ghUser.name ?? ghUser.login,
            avatarUrl: ghUser.avatar_url ?? null,
          },
          ...ghOrgs.map((org) => ({
            githubId: org.id,
            login: org.login,
            name: org.name ?? org.login,
            avatarUrl: org.avatar_url ?? null,
          })),
        ],
      },
      token,
    );
  if (!storeResult.ok) {
    console.error(
      '[github-connection] failed to store GitHub OAuth connection:',
      storeResult.message,
    );
    return NextResponse.redirect(`${settingsUrl}?error=store_failed`);
  }

  const response = NextResponse.redirect(settingsUrl);
  response.cookies.delete('gh_oauth_state');
  return response;
}

function getOAuthOrigin(request: Request): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL environment variable is required in production',
    );
  }
  return new URL(request.url).origin;
}
