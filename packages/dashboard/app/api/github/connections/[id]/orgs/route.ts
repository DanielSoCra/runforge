import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
} from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const orgs = await getDashboardStores().githubConnections.listOrganizations(
    id,
  );

  if (!orgs.ok) {
    console.error('[orgs] Failed to fetch orgs for connection:', orgs.message);
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 });
  }
  return NextResponse.json(
    orgs.value.map((org) => ({
      id: org.id,
      login: org.login,
      name: org.name,
      avatar_url: org.avatarUrl,
      is_selected: org.isSelected,
    })),
  );
}
