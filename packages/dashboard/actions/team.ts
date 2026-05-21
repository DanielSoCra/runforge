'use server';
import { revalidatePath } from 'next/cache';
import { requireDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';

type TeamRole = 'admin' | 'viewer';

export async function createInvitation(formData: FormData) {
  const session = await requireDashboardAdmin();

  const providerHandle = formData.get('provider_handle');
  const role = readRole(formData.get('role'));

  if (!providerHandle || typeof providerHandle !== 'string' || providerHandle.trim() === '') {
    throw new Error('GitHub username is required');
  }

  const result = await getDashboardStores().team.createInvitation({
    providerHandle: providerHandle.trim(),
    role,
    invitedBy: session.user.id,
  });
  if (!result.ok) {
    console.error('[team] createInvitation failed:', result.message);
    if (result.error === 'conflict') {
      throw new Error('A pending invitation for this user already exists');
    }
    throw new Error('Failed to create invitation');
  }
  revalidatePath('/team');
}

export async function changeRole(memberId: string, newRole: TeamRole) {
  await requireDashboardAdmin();

  const result = await getDashboardStores().team.changeMemberRole(
    memberId,
    newRole,
  );
  if (!result.ok) {
    if (result.error === 'conflict') {
      throw new Error('Cannot demote the last admin. Assign another admin first.');
    }
    if (result.error === 'not-found') throw new Error('Member not found.');
    console.error('[team] changeRole failed:', result.message);
    throw new Error('Failed to change member role');
  }
  revalidatePath('/team');
}

export async function removeMember(memberId: string) {
  await requireDashboardAdmin();

  const result = await getDashboardStores().team.removeMember(memberId);
  if (!result.ok) {
    if (result.error === 'conflict') {
      throw new Error('Cannot remove the last admin. Assign another admin first.');
    }
    if (result.error === 'not-found') throw new Error('Member not found.');
    console.error('[team] removeMember failed:', result.message);
    throw new Error('Failed to remove member');
  }
  revalidatePath('/team');
}

function readRole(value: FormDataEntryValue | null): TeamRole {
  if (value === 'admin' || value === 'viewer') return value;
  throw new Error('Invalid role');
}
