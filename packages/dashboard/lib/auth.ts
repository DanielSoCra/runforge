import { createClient } from '@/lib/supabase/server';

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export async function requireAdmin(supabase: SupabaseClient) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: member, error } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('[auth] team_members query failed:', error.message);
  }
  if (member?.role !== 'admin') throw new Error('Admin access required');
  return user;
}

/** Returns true if the current user is an admin. Never throws. */
export async function isAdmin(supabase: SupabaseClient): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: member, error } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('[auth] team_members query failed:', error.message);
  }
  return member?.role === 'admin';
}
