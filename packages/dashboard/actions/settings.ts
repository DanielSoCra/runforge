'use server';
import { revalidatePath } from 'next/cache';
import { requireDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';

export async function updateGlobalSettings(formData: FormData) {
  await requireDashboardAdmin();

  // Validate concurrency_limit
  const raw = formData.get('concurrency_limit');
  const concurrencyLimit = Number(raw);
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 20) {
    throw new Error('Concurrency limit must be an integer between 1 and 20');
  }

  const result = await getDashboardStores().settings.updateGlobalSettings({
    concurrencyLimit,
  });
  if (!result.ok) {
    console.error('[settings] updateGlobalSettings failed:', result.message);
    throw new Error(
      result.error === 'not-found'
        ? 'Failed to load settings'
        : 'Failed to update settings',
    );
  }
  revalidatePath('/settings');
}
