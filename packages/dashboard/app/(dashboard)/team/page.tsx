import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { changeRole, removeMember } from '@/actions/team';
import { InviteForm } from '@/components/invite-form';
import { isAdmin } from '@/lib/auth';

export default async function TeamPage() {
  const supabase = await createClient();
  const admin = await isAdmin(supabase);
  const { data: members } = await supabase
    .from('team_members')
    .select('*, user:user_id(email, raw_user_meta_data)')
    .order('granted_at');

  const { data: invitations } = await supabase
    .from('invitations')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>

      {/* Members list */}
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {members?.map((member) => {
            const meta = (member.user as any)?.raw_user_meta_data;
            return (
              <div key={member.id} className="flex items-center justify-between py-2">
                <div>
                  <span className="font-medium text-sm">{meta?.user_name ?? (member.user as any)?.email}</span>
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

      {/* Pending invitations */}
      {(invitations?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Pending Invitations</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {invitations?.map((inv) => (
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
