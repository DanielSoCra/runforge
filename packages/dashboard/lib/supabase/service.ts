import { createClient } from '@supabase/supabase-js';

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');
  return createClient(url, key);
}
