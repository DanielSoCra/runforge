'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

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

  // Upsert by owner+name — preserve existing settings, just update connection_id
  for (const { owner, name } of repos) {
    await supabase.from('repos').upsert(
      { owner, name, connection_id: connectionId, enabled: false },
      { onConflict: 'owner,name', ignoreDuplicates: false },
    );
  }

  // Notify daemon best-effort
  fetch(`${process.env.DAEMON_URL}/repos/reload`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    .catch(() => {});

  revalidatePath('/repos');
}
