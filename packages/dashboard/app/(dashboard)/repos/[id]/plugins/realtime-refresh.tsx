'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function RealtimeRefresh({ repoId }: { repoId: string }) {
  const router = useRouter();
  const supabase = createClient();
  useEffect(() => {
    const channel = supabase.channel(`repo_plugins_${repoId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'repo_plugins',
          filter: `repo_id=eq.${repoId}` }, () => router.refresh())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [repoId, router, supabase]);
  return null;
}
