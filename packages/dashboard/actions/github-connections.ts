'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { daemonFetch } from '@/lib/daemon-fetch';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

function notifyDaemonReload() {
  daemonFetch('/repos/reload', {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

export async function removeConnection(connectionId: string) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Collect repo IDs before deleting connection so we can disable them after.
  // Order matters: delete connection first so that if it fails, repos are untouched.
  // ON DELETE SET NULL (migration 005) automatically nulls connection_id on repos.
  const { data: linkedRepos, error: selectError } = await supabase.from('repos')
    .select('id')
    .eq('connection_id', connectionId);
  if (selectError) {
    console.error('[github-connections] removeConnection failed to collect repos:', selectError);
  }

  const { error } = await supabase.from('github_connections').delete().eq('id', connectionId);
  if (error) {
    console.error('[github-connections] removeConnection delete failed:', error);
    throw new Error('Failed to remove connection');
  }

  // Disable repos after connection is deleted — connection_id already nulled by cascade.
  // If this fails, repos are disconnected but still enabled (less severe than the reverse).
  if (linkedRepos && linkedRepos.length > 0) {
    const repoIds = linkedRepos.map((r) => r.id);
    const { error: reposError } = await supabase.from('repos')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .in('id', repoIds);
    if (reposError) {
      console.error('[github-connections] removeConnection disable repos failed:', reposError);
      // Connection is already deleted — log but don't throw to avoid misleading error
    }
  }

  // Notify daemon to drop stale polling for disconnected repos
  notifyDaemonReload();

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
  notifyDaemonReload();

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
