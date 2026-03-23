'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';

type EnableAllResult = {
  succeeded: string[];
  failed: string[];
  error?: string;
} | null;

export function EnableAllForm({
  action,
}: {
  action: () => Promise<{ succeeded: string[]; failed: string[]; error?: string }>;
}) {
  const [result, dispatch, isPending] = useActionState<EnableAllResult, FormData>(
    async () => action(),
    null,
  );

  return (
    <div>
      <form action={dispatch}>
        <Button variant="ghost" size="sm" type="submit" disabled={isPending}>
          {isPending ? 'Enabling…' : 'Enable All'}
        </Button>
      </form>
      {result && !result.error && (result.succeeded.length > 0 || result.failed.length > 0) && (
        <p className="mt-1 text-xs text-zinc-400">
          {result.succeeded.length > 0 && (
            <span className="text-green-400">{result.succeeded.length} enabled</span>
          )}
          {result.succeeded.length > 0 && result.failed.length > 0 && ' · '}
          {result.failed.length > 0 && (
            <span className="text-red-400">{result.failed.length} failed ({result.failed.join(', ')})</span>
          )}
        </p>
      )}
      {result?.error && (
        <p className="mt-1 text-xs text-red-400">{result.error}</p>
      )}
    </div>
  );
}
