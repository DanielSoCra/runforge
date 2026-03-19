'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function RealtimeRefresh({ repoId }: { repoId: string }) {
  const router = useRouter();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const supabase = useRef(createClient()).current;
  useEffect(() => {
    const channel = supabase.channel(`repo_plugins_${repoId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'repo_plugins',
          filter: `repo_id=eq.${repoId}` }, () => router.refresh())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [repoId, router, supabase]);
  return null;
}
