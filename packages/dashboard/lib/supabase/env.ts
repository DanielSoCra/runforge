export function getSupabaseEnv(): never {
  throw new Error(
    'Dashboard Supabase environment variables are no longer used. Configure the app-owned data and auth services instead.',
  );
}
