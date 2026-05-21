'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const PLUGIN_REFRESH_INTERVAL_MS = 5_000;

export function RealtimeRefresh({ repoId }: { repoId: string }) {
  const router = useRouter();

  useEffect(() => {
    const interval = window.setInterval(() => {
      router.refresh();
    }, PLUGIN_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [repoId, router]);

  return null;
}
