'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function createRepo(formData: FormData) {
  const supabase = await createClient();
  const { error, data } = await supabase.from('repos').insert({
    owner: formData.get('owner') as string,
    name: formData.get('name') as string,
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit: Number(formData.get('budget_limit')) || null,
    concurrency_limit: Number(formData.get('concurrency_limit')) || 1,
    enabled: false, // always starts disabled
  }).select('id').single();

  if (error) throw new Error(error.message);
  revalidatePath('/repos');
  redirect(`/repos/${data!.id}`);
}

export async function updateRepo(id: string, formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from('repos').update({
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit: Number(formData.get('budget_limit')) || null,
    concurrency_limit: Number(formData.get('concurrency_limit')) || 1,
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
}

export async function enableRepo(id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('repos')
    .update({ enabled: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function disableRepo(id: string) {
  const supabase = await createClient();
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
  const { error } = await supabase.from('repos')
    .update({ deleted_at: new Date().toISOString(), enabled: false })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/repos');
  redirect('/repos');
}
