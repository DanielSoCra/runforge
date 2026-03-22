'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

function notifyDaemonReload() {
  fetch(`${process.env.DAEMON_URL}/repos/reload`, {
    method: 'POST',
    headers: { 'X-Requested-By': 'dashboard' },
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

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
  const concurrency_limit = concurrencyRaw === '' || concurrencyRaw === null ? undefined : Number(concurrencyRaw);

  const { error, data } = await supabase.from('repos').insert({
    owner: owner.trim(),
    name: name.trim(),
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit,
    concurrency_limit,
    enabled: false, // always starts disabled
  }).select('id').single();

  if (error) {
    console.error('[repos] createRepo failed:', error);
    throw new Error('Failed to create repository');
  }
  revalidatePath('/repos');
  redirect(`/repos/${data!.id}`);
}

export async function updateRepo(id: string, formData: FormData) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const budgetRaw = formData.get('budget_limit');
  const budget_limit = budgetRaw === '' || budgetRaw === null ? null : Number(budgetRaw);

  const concurrencyRaw = formData.get('concurrency_limit');
  const concurrency_limit = concurrencyRaw === '' || concurrencyRaw === null ? undefined : Number(concurrencyRaw);

  const { error } = await supabase.from('repos').update({
    staging_branch: (formData.get('staging_branch') as string) || 'staging',
    production_branch: (formData.get('production_branch') as string) || 'main',
    budget_limit,
    concurrency_limit,
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  if (error) {
    console.error('[repos] updateRepo failed:', error);
    throw new Error('Failed to update repository');
  }
  revalidatePath(`/repos/${id}`);
}

export async function enableRepo(id: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Spec: credentials must exist before enabling (FUNC-AC-DASHBOARD line 48-51)
  const { data: keys, error: keysError } = await supabase.from('api_keys')
    .select('key_type')
    .eq('repo_id', id);
  if (keysError) {
    console.error('[repos] enableRepo credential check failed:', keysError);
    throw new Error('Failed to verify repository credentials');
  }

  const hasSourceControl = keys?.some(k => k.key_type === 'source-control');
  const hasModelProvider = keys?.some(k => k.key_type === 'model-provider');

  if (!hasSourceControl || !hasModelProvider) {
    throw new Error(
      'Cannot enable repository without both source-control and model-provider credentials'
    );
  }

  const { error } = await supabase.from('repos')
    .update({ enabled: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    console.error('[repos] enableRepo failed:', error);
    throw new Error('Failed to enable repository');
  }
  notifyDaemonReload();
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function disableRepo(id: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { error } = await supabase.from('repos')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    console.error('[repos] disableRepo failed:', error);
    throw new Error('Failed to disable repository');
  }
  notifyDaemonReload();
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function deleteRepo(id: string) {
  // Soft delete — preserves run history
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Spec: only a disabled repo can be removed (FUNC-AC-DASHBOARD line 63-66)
  const { data: repo, error: fetchError } = await supabase.from('repos')
    .select('enabled')
    .eq('id', id)
    .single();
  if (fetchError || !repo) {
    throw new Error('Repository not found');
  }
  if (repo.enabled) {
    throw new Error('Cannot delete an enabled repository — disable it first');
  }

  const { error } = await supabase.from('repos')
    .update({ deleted_at: new Date().toISOString(), enabled: false })
    .eq('id', id);
  if (error) {
    console.error('[repos] deleteRepo failed:', error);
    throw new Error('Failed to delete repository');
  }
  revalidatePath('/repos');
  redirect('/repos');
}
