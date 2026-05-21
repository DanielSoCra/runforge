'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

function readRefreshInterval() {
  const configured = Number.parseInt(
    process.env.NEXT_PUBLIC_REFRESH_INTERVAL_MS ?? '',
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REFRESH_INTERVAL_MS;
}

export function BriefingRealtime() {
  const router = useRouter();

  useEffect(() => {
    const interval = window.setInterval(() => {
      router.refresh();
    }, readRefreshInterval());

    return () => {
      window.clearInterval(interval);
    };
  }, [router]);

  return null;
}
