'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function removeConnection(connectionId: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Disconnect repos before deleting connection
  await supabase.from('repos')
    .update({ enabled: false, connection_id: null, updated_at: new Date().toISOString() })
    .eq('connection_id', connectionId);

  const { error } = await supabase.from('github_connections').delete().eq('id', connectionId);
  if (error) throw new Error(error.message);

  revalidatePath('/settings');
  revalidatePath('/repos');
}

export async function importRepos(
  connectionId: string,
  repos: Array<{ owner: string; name: string }>,
) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  if (repos.length === 0) return;

  for (const { owner, name } of repos) {
    if (!SAFE_PATTERN.test(owner)) {
      throw new Error('Owner must contain only alphanumeric characters, dots, underscores, and hyphens');
    }
    if (!SAFE_PATTERN.test(name)) {
      throw new Error('Name must contain only alphanumeric characters, dots, underscores, and hyphens');
    }
  }

  // Two-step import: insert new repos as disabled, then update connection_id for all.
  // This preserves the enabled state of already-existing repos (#176).
  for (const { owner, name } of repos) {
    // Step 1: Insert new repos only (ignoreDuplicates skips existing rows)
    const { error: insertErr } = await supabase.from('repos').upsert(
      { owner, name, connection_id: connectionId, deleted_at: null, enabled: false },
      { onConflict: 'owner,name', ignoreDuplicates: true },
    );
    if (insertErr) {
      console.error('[github-connections] importRepos insert failed:', insertErr);
      throw new Error('Failed to import repository');
    }

    // Step 2: Update connection_id for all matching repos (preserves enabled state)
    const { error: updateErr } = await supabase.from('repos')
      .update({ connection_id: connectionId, deleted_at: null })
      .eq('owner', owner)
      .eq('name', name);
    if (updateErr) {
      console.error('[github-connections] importRepos update failed:', updateErr);
      throw new Error('Failed to import repository');
    }
  }

  // Notify daemon best-effort
  fetch(`${process.env.DAEMON_URL}/repos/reload`, {
    method: 'POST',
    headers: { 'X-Requested-By': 'dashboard' },
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  revalidatePath('/repos');
}

export async function removeRepo(repoId: string, connectionId: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Spec: only a disabled repo can be removed (FUNC-AC-DASHBOARD line 63-66)
  const { data: repo, error: fetchError } = await supabase
    .from('repos')
    .select('enabled')
    .eq('id', repoId)
    .eq('connection_id', connectionId)
    .single();
  if (fetchError || !repo) {
    throw new Error('Repository not found');
  }
  if (repo.enabled) {
    throw new Error('Cannot remove an enabled repository — disable it first');
  }

  const { error } = await supabase
    .from('repos')
    .update({ deleted_at: new Date().toISOString(), enabled: false })
    .eq('id', repoId)
    .eq('connection_id', connectionId);

  if (error) {
    console.error('[github-connections] removeRepo failed:', error);
    throw new Error('Failed to remove repository');
  }

  revalidatePath('/repos');
}
