'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: member } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (member?.role !== 'admin') throw new Error('Admin access required');
  return user;
}

export async function createInvitation(formData: FormData) {
  const supabase = await createClient();
  const user = await requireAdmin(supabase);
  const { error } = await supabase.from('invitations').insert({
    provider_handle: formData.get('provider_handle') as string,
    role: formData.get('role') as 'admin' | 'viewer',
    invited_by: user.id,
    status: 'pending',
  });
  if (error) throw new Error(error.message);
  revalidatePath('/team');
}

export async function changeRole(memberId: string, newRole: 'admin' | 'viewer') {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Guard: cannot demote if last admin
  if (newRole === 'viewer') {
    const { data: otherAdmins } = await supabase
      .from('team_members')
      .select('id')
      .eq('role', 'admin')
      .neq('id', memberId);
    if (!otherAdmins?.length) {
      throw new Error('Cannot demote the last admin. Promote another member first.');
    }
  }

  const { error } = await supabase.from('team_members')
    .update({ role: newRole })
    .eq('id', memberId);
  if (error) throw new Error(error.message);
  revalidatePath('/team');
}

export async function removeMember(memberId: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Guard: cannot remove if last admin
  // Single-tenant app: RLS restricts team_members reads to this team's members.
  // This count is correct for this deployment model.
  const { data: member } = await supabase.from('team_members').select('role').eq('id', memberId).single();
  if (member?.role === 'admin') {
    const { data: admins } = await supabase.from('team_members').select('id').eq('role', 'admin');
    if ((admins?.length ?? 0) <= 1) {
      throw new Error('Cannot remove the last admin.');
    }
  }

  const { error } = await supabase.from('team_members').delete().eq('id', memberId);
  if (error) throw new Error(error.message);
  revalidatePath('/team');
}
