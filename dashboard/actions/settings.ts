'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export async function updateGlobalSettings(formData: FormData) {
  const supabase = await createClient();
  // Single-row table — fetch the row ID first, then update by ID
  const { data: existing } = await supabase.from('global_settings').select('id').single();
  if (!existing) throw new Error('Global settings row missing — check migration');
  const { error } = await supabase
    .from('global_settings')
    .update({
      concurrency_limit: Number(formData.get('concurrency_limit')),
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}
