'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';
import { daemonFetch, DaemonAuthError } from '@/lib/daemon-fetch';

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

function parseBudgetLimit(raw: FormDataEntryValue | null) {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new Error('Budget limit must be a valid non-negative number');
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Budget limit must be a valid non-negative number');
  }
  return value;
}

function parseConcurrencyLimit(raw: FormDataEntryValue | null) {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error('Concurrency limit must be a positive integer');
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Concurrency limit must be a positive integer');
  }
  return value;
}

function notifyDaemonReload() {
  daemonFetch('/repos/reload', {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  }).catch((e) => {
    if (e instanceof DaemonAuthError) {
      console.error('[repos] daemon reload failed:', e.message);
    }
  });
}

function readBranch(value: FormDataEntryValue | null, fallback: string) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

export async function createRepo(formData: FormData) {
  await requireDashboardAdmin();

  const owner = formData.get('owner') as string;
  const name = formData.get('name') as string;

  if (!owner || typeof owner !== 'string' || owner.trim() === '') {
    throw new Error('Repository owner is required');
  }
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('Repository name is required');
  }
  if (!SAFE_PATTERN.test(owner)) {
    throw new Error(
      'Owner must contain only alphanumeric characters, dots, underscores, and hyphens',
    );
  }
  if (!SAFE_PATTERN.test(name)) {
    throw new Error(
      'Name must contain only alphanumeric characters, dots, underscores, and hyphens',
    );
  }

  const budget_limit = parseBudgetLimit(formData.get('budget_limit'));
  const concurrency_limit = parseConcurrencyLimit(
    formData.get('concurrency_limit'),
  );

  const result = await getDashboardStores().repositories.createRepository({
    owner: owner.trim(),
    name: name.trim(),
    stagingBranch: readBranch(formData.get('staging_branch'), 'staging'),
    productionBranch: readBranch(formData.get('production_branch'), 'main'),
    budgetLimit: budget_limit,
    concurrencyLimit: concurrency_limit,
  });

  if (!result.ok) {
    console.error('[repos] createRepo failed:', result.message);
    throw new Error('Failed to create repository');
  }
  revalidatePath('/repos');
  redirect(`/repos/${result.value.id}`);
}

export async function updateRepo(id: string, formData: FormData) {
  await requireDashboardAdmin();

  const budget_limit = parseBudgetLimit(formData.get('budget_limit'));
  const concurrency_limit = parseConcurrencyLimit(
    formData.get('concurrency_limit'),
  );

  const result = await getDashboardStores().repositories.updateRepository(id, {
    stagingBranch: readBranch(formData.get('staging_branch'), 'staging'),
    productionBranch: readBranch(formData.get('production_branch'), 'main'),
    budgetLimit: budget_limit,
    concurrencyLimit: concurrency_limit,
  });

  if (!result.ok) {
    if (result.error === 'not-found') throw new Error('Repository not found');
    console.error('[repos] updateRepo failed:', result.message);
    throw new Error('Failed to update repository');
  }
  revalidatePath(`/repos/${id}`);
}

export async function enableRepo(id: string) {
  await requireDashboardAdmin();
  const stores = getDashboardStores();

  // Spec: credentials must exist before enabling (FUNC-AC-DASHBOARD line 48-51)
  const credentials = await stores.credentials.listRepoCredentialMetadata(id);
  if (!credentials.ok) {
    if (credentials.error === 'not-found') {
      throw new Error('Repository not found');
    }
    console.error(
      '[repos] enableRepo credential check failed:',
      credentials.message,
    );
    throw new Error('Failed to verify repository credentials');
  }

  const hasSourceControl = credentials.value.some(
    (key) => key.key_type === 'source-control',
  );
  const hasModelProvider = credentials.value.some(
    (key) => key.key_type === 'model-provider',
  );

  if (!hasSourceControl || !hasModelProvider) {
    throw new Error(
      'Cannot enable repository without both source-control and model-provider credentials',
    );
  }

  const result = await stores.repositories.setRepositoryEnabled(id, true);
  if (!result.ok) {
    if (result.error === 'not-found') throw new Error('Repository not found');
    console.error('[repos] enableRepo failed:', result.message);
    throw new Error('Failed to enable repository');
  }
  notifyDaemonReload();
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function disableRepo(id: string) {
  await requireDashboardAdmin();

  const result = await getDashboardStores().repositories.setRepositoryEnabled(
    id,
    false,
  );
  if (!result.ok) {
    if (result.error === 'not-found') throw new Error('Repository not found');
    console.error('[repos] disableRepo failed:', result.message);
    throw new Error('Failed to disable repository');
  }
  notifyDaemonReload();
  revalidatePath(`/repos/${id}`);
  revalidatePath('/repos');
}

export async function deleteRepo(id: string) {
  // Soft delete — preserves run history
  await requireDashboardAdmin();

  // Spec: only a disabled repo can be removed (FUNC-AC-DASHBOARD line 63-66)
  const result = await getDashboardStores().repositories.removeRepository(id);
  if (result.ok) {
    revalidatePath('/repos');
    redirect('/repos');
    return;
  }
  if (result.error === 'not-found') throw new Error('Repository not found');
  if (result.error === 'conflict') {
    throw new Error('Cannot delete an enabled repository — disable it first');
  }

  console.error('[repos] deleteRepo failed:', result.message);
  throw new Error('Failed to delete repository');
}
