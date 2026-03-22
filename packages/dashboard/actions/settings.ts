'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export async function updateGlobalSettings(formData: FormData) {
  const supabase = await createClient();
  await requireAdmin(supabase);

  // Validate concurrency_limit
  const raw = formData.get('concurrency_limit');
  const concurrencyLimit = Number(raw);
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 20) {
    throw new Error('Concurrency limit must be an integer between 1 and 20');
  }

  const { data: existing } = await supabase.from('global_settings').select('id').single();
  if (!existing) throw new Error('Global settings row missing — check migration');
  const { error } = await supabase
    .from('global_settings')
    .update({
      concurrency_limit: concurrencyLimit,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);
  if (error) throw new Error('Failed to update settings');
  revalidatePath('/settings');
}
