'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function createRepo(formData: FormData) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const owner = formData.get('owner') as string;
  const name = formData.get('name') as string;

  if (!owner || typeof owner !== 'string' || owner.trim() === '') {
    throw new Error('Repository owner is required');
  }
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('Repository name is required');
  }
  if (!SAFE_PATTERN.test(owner)) {
    throw new Error('Owner must contain only alphanumeric characters, dots, underscores, and hyphens');
  }
  if (!SAFE_PATTERN.test(name)) {
    throw new Error('Name must contain only alphanumeric characters, dots, underscores, and hyphens');
  }

  const budgetRaw = formData.get('budget_limit');
  const budget_limit = budgetRaw === '' || budgetRaw === null ? null : Number(budgetRaw);

  const concurrencyRaw = formData.get('concurrency_limit');
  const concurrency_limit = concurrencyRaw === '' || concurrencyRaw === null ? null : Number(concurrencyRaw);

  const { error, data } = await supabase.from('repos').insert({
    owner: owner.trim(),
    name: name.trim(),
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit,
    concurrency_limit,
    enabled: false, // always starts disabled
  }).select('id').single();

  if (error) throw new Error(error.message);
  revalidatePath('/repos');
  redirect(`/repos/${data!.id}`);
}

export async function updateRepo(id: string, formData: FormData) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const budgetRaw = formData.get('budget_limit');
  const budget_limit = budgetRaw === '' || budgetRaw === null ? null : Number(budgetRaw);

  const concurrencyRaw = formData.get('concurrency_limit');
  const concurrency_limit = concurrencyRaw === '' || concurrencyRaw === null ? null : Number(concurrencyRaw);

  const { error } = await supabase.from('repos').update({
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit,
    concurrency_limit,
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
}

export async function enableRepo(id: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { error } = await supabase.from('repos')
    .update({ enabled: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function disableRepo(id: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { error } = await supabase.from('repos')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function deleteRepo(id: string) {
  // Soft delete — preserves run history
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { error } = await supabase.from('repos')
    .update({ deleted_at: new Date().toISOString(), enabled: false })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/repos');
  redirect('/repos');
}
