'use server';
import { revalidatePath } from 'next/cache';
import { requireDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';
import { daemonFetch, DaemonAuthError } from '@/lib/daemon-fetch';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

function notifyDaemonReload() {
  daemonFetch('/repos/reload', {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  }).catch((e) => {
    if (e instanceof DaemonAuthError) {
      console.error('[github-connections] daemon reload failed:', e.message);
    }
  });
}

export async function removeConnection(connectionId: string) {
  await requireDashboardAdmin();

  const result =
    await getDashboardStores().githubConnections.removeConnection(
      connectionId,
    );
  if (!result.ok) {
    console.error(
      '[github-connections] removeConnection failed:',
      result.message,
    );
    throw new Error('Failed to remove connection');
  }
  if (result.value.disableError) {
    console.error(
      '[github-connections] removeConnection disable repos failed:',
      result.value.disableError,
    );
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
  await requireDashboardAdmin();

  if (repos.length === 0) return;

  for (const { owner, name } of repos) {
    if (!SAFE_PATTERN.test(owner)) {
      throw new Error('Owner must contain only alphanumeric characters, dots, underscores, and hyphens');
    }
    if (!SAFE_PATTERN.test(name)) {
      throw new Error('Name must contain only alphanumeric characters, dots, underscores, and hyphens');
    }
  }

  const result =
    await getDashboardStores().githubConnections.importRepositories(
      connectionId,
      repos,
    );
  if (!result.ok) {
    console.error('[github-connections] importRepos failed:', result.message);
    throw new Error('Failed to import repository');
  }

  // Notify daemon best-effort
  notifyDaemonReload();

  revalidatePath('/repos');
}

export async function removeRepo(repoId: string, connectionId: string) {
  await requireDashboardAdmin();

  const result =
    await getDashboardStores().githubConnections.removeRepository(
      repoId,
      connectionId,
    );
  if (result.ok) {
    revalidatePath('/repos');
    return;
  }
  if (result.error === 'not-found') {
    throw new Error('Repository not found');
  }
  if (result.error === 'conflict') {
    throw new Error('Cannot remove an enabled repository — disable it first');
  }

  console.error('[github-connections] removeRepo failed:', result.message);
  throw new Error('Failed to remove repository');
}
