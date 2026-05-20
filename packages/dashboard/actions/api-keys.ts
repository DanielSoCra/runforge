'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { getDashboardStores } from '@/lib/data/stores';

const VALID_KEY_TYPES = ['source-control', 'model-provider'] as const;
type KeyType = typeof VALID_KEY_TYPES[number];

export async function upsertApiKey(formData: FormData) {
  const supabase = await createClient();

  // Admin-only — RPC uses SECURITY DEFINER which bypasses RLS
  await requireAdmin(supabase);

  const repoId = formData.get('repo_id');
  const keyType = formData.get('key_type');
  const keyValue = formData.get('key_value');

  if (!repoId || typeof repoId !== 'string' || repoId.trim() === '') {
    throw new Error('Invalid repo_id');
  }
  if (!keyType || typeof keyType !== 'string' || !VALID_KEY_TYPES.includes(keyType as KeyType)) {
    throw new Error('Invalid key_type');
  }
  if (!keyValue || typeof keyValue !== 'string' || keyValue.trim() === '') {
    throw new Error('Key value is required');
  }

  const result = await getDashboardStores().credentials.storeRepoCredential(
    repoId,
    keyType as KeyType,
    keyValue,
  );

  if (!result.ok) {
    console.error(
      '[api-keys] storeRepoCredential failed:',
      result.error,
      result.message,
    );
    throw new Error('Failed to save credential');
  }
  revalidatePath(`/repos/${repoId}`);
}
