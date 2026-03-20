import { createClient } from '@/lib/supabase/server';

export async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: member } = await supabase.from('team_members')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (member?.role !== 'admin') throw new Error('Admin access required');
  return user;
}
