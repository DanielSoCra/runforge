'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export async function createInvitation(formData: FormData) {
  const supabase = await createClient();
  const user = await requireAdmin(supabase);

  const providerHandle = formData.get('provider_handle');
  const role = formData.get('role');

  if (!providerHandle || typeof providerHandle !== 'string' || providerHandle.trim() === '') {
    throw new Error('GitHub username is required');
  }
  if (role !== 'admin' && role !== 'viewer') {
    throw new Error('Invalid role');
  }

  const { error } = await supabase.from('invitations').insert({
    provider_handle: providerHandle.trim(),
    role,
    invited_by: user.id,
    status: 'pending',
  });
  if (error) {
    // Handle duplicate pending invitation gracefully
    if (error.code === '23505') throw new Error('A pending invitation for this user already exists');
    throw new Error('Failed to create invitation');
  }
  revalidatePath('/team');
}

export async function changeRole(memberId: string, newRole: 'admin' | 'viewer') {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { data, error } = await (supabase as any).rpc('change_member_role', {
    p_member_id: memberId,
    p_new_role: newRole,
  });
  if (error) {
    console.error('[team] changeRole RPC failed:', error);
    throw new Error('Failed to change member role');
  }
  if (data === 'last_admin') throw new Error('Cannot demote the last admin. Assign another admin first.');
  if (data === 'not_found') throw new Error('Member not found.');
  revalidatePath('/team');
}

export async function removeMember(memberId: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { data, error } = await (supabase as any).rpc('remove_team_member', {
    p_member_id: memberId,
  });
  if (error) {
    console.error('[team] removeMember RPC failed:', error);
    throw new Error('Failed to remove member');
  }
  if (data === 'last_admin') throw new Error('Cannot remove the last admin. Assign another admin first.');
  if (data === 'not_found') throw new Error('Member not found.');
  revalidatePath('/team');
}
