'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function RealtimeProvider() {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const channel = supabase
      .channel('runs-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'runs' },
        () => router.refresh()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [router, supabase]);

  return null;
}
