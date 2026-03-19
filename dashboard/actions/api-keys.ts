'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export async function upsertApiKey(formData: FormData) {
  const supabase = await createClient();
  const repoId = formData.get('repo_id') as string;
  const keyType = formData.get('key_type') as string;
  const keyValue = formData.get('key_value') as string;

  // Encryption happens inside Postgres via pgp_sym_encrypt
  // using the Supabase Vault encryption key
  const { error } = await supabase.rpc('upsert_api_key_encrypted', {
    p_repo_id: repoId,
    p_key_type: keyType,
    p_plaintext: keyValue,
  });

  if (error) throw new Error(error.message);
  revalidatePath(`/repos/${repoId}`);
}
