import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { changeRole, removeMember } from '@/actions/team';
import { InviteForm } from '@/components/invite-form';
import { isDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';
import { PageError } from '@/components/page-error';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const admin = await isDashboardAdmin();
  const teamData = await getDashboardStores().team.readTeamPage({
    includePendingInvitations: admin,
  });

  if (!teamData.ok) {
    console.error('[team] failed to load team page:', teamData.message);
    return <PageError />;
  }

  const { members, invitations } = teamData.value;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>

      {/* Members list */}
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {members.map((member) => {
            const displayName =
              member.user?.name || member.user?.email || 'Unknown user';
            return (
              <div key={member.id} className="flex items-center justify-between py-2">
                <div>
                  <span className="font-medium text-sm">{displayName}</span>
                  <Badge variant={member.role === 'admin' ? 'default' : 'secondary'} className="ml-2">
                    {member.role}
                  </Badge>
                </div>
                {admin && (
                  <div className="flex gap-2">
                    <form action={changeRole.bind(null, member.id, member.role === 'admin' ? 'viewer' : 'admin')}>
                      <Button type="submit" variant="ghost" size="sm">
                        Make {member.role === 'admin' ? 'viewer' : 'admin'}
                      </Button>
                    </form>
                    <form action={removeMember.bind(null, member.id)}>
                      <Button type="submit" variant="ghost" size="sm" className="text-destructive">Remove</Button>
                    </form>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Pending invitations — admin-only */}
      {admin && invitations.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Pending Invitations</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-sm py-1">
                <span className="font-mono">{inv.provider_handle}</span>
                <Badge variant="secondary">{inv.role}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Invite form */}
      {admin && (
        <Card>
          <CardHeader><CardTitle>Invite Member</CardTitle></CardHeader>
          <CardContent>
            <InviteForm />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
