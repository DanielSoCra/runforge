// src/supabase/client.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (url || key) {
      const missing = url ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_URL';
      console.warn(
        `[supabase] Partial configuration detected: ${missing} is not set. ` +
        `Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to enable DB mode. ` +
        `Falling back to legacy mode.`,
      );
    }
    return null;
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** For testing — reset the singleton so tests can inject different env vars. */
export function resetSupabaseClient(): void {
  _client = null;
}
