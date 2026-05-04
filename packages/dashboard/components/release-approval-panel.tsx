'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface ReleaseResponse {
  status?: 'success' | 'no-completed-work';
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

export function ReleaseApprovalPanel({ issueCount }: { issueCount: number }) {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  async function approveRelease() {
    setSubmitting(true);
    setMessage(null);
    setPrUrl(null);
    try {
      const res = await fetch('/api/daemon/release', { method: 'POST' });
      const data = await res.json() as ReleaseResponse;
      if (!res.ok) {
        setMessage(data.error ?? 'Release request failed');
      } else if (data.status === 'no-completed-work') {
        setMessage('No completed work is ready for release.');
      } else if (data.status === 'success') {
        setMessage(`Release proposal #${data.prNumber} created`);
        setPrUrl(data.prUrl ?? null);
      } else {
        setMessage('Release request completed.');
      }
    } catch {
      setMessage('Daemon unreachable');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        onClick={approveRelease}
        disabled={submitting || issueCount === 0}
      >
        {submitting ? 'Creating release...' : 'Approve production release'}
      </Button>
      {message && (
        <div className="text-xs text-muted-foreground">
          <span>{message}</span>
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-primary hover:underline"
            >
              Open release PR
            </a>
          )}
        </div>
      )}
    </div>
  );
}
