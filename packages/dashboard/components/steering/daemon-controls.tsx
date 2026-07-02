'use client';

/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — emergency daemon controls.
 *
 * Pause / Halt / Resume buttons for admins on the steering pane. Halt is
 * confirm-gated with explicit copy: it kills in-flight workers; parked runs
 * resume via Resume. The halt response summary (parked/terminated/escalated)
 * renders inline after success.
 *
 * Role gating: the server page passes `isAdmin` from `isDashboardAdmin()`; the
 * controls render only for admins. The API routes independently enforce the same
 * admin check fail-closed.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export interface DaemonControlsProps {
  isAdmin: boolean;
}

interface HaltSummary {
  halted: boolean;
  parked?: number[];
  terminated?: number;
  escalated?: number;
}

export function DaemonControls({ isAdmin }: DaemonControlsProps): React.ReactElement | null {
  const [haltSummary, setHaltSummary] = useState<HaltSummary | null>(null);
  const [haltConfirmOpen, setHaltConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) {
    return null;
  }

  async function postControl(path: string): Promise<unknown> {
    const res = await fetch(`/api/daemon/${path}`, { method: 'POST' });
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      throw new Error((json as { error?: string }).error ?? `Request failed (HTTP ${res.status})`);
    }
    return json;
  }

  async function handlePause() {
    setPending(true);
    setError(null);
    try {
      await postControl('pause');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pause failed');
    } finally {
      setPending(false);
    }
  }

  async function handleResume() {
    setPending(true);
    setError(null);
    try {
      await postControl('resume');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed');
    } finally {
      setPending(false);
    }
  }

  async function handleHalt() {
    setPending(true);
    setError(null);
    try {
      const summary = (await postControl('halt')) as HaltSummary;
      setHaltSummary(summary);
      setHaltConfirmOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Halt failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={handlePause}
        >
          Pause
        </Button>
        <Dialog open={haltConfirmOpen} onOpenChange={setHaltConfirmOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="destructive" size="sm" disabled={pending}>
              Halt
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Confirm halt</DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm">
                  Halt kills in-flight workers. Parked runs resume via Resume.
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex flex-row justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setHaltConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={handleHalt}
              >
                {pending ? 'Halting…' : 'Halt now'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={handleResume}
        >
          Resume
        </Button>
      </div>

      {haltSummary !== null && haltSummary.halted && (
        <p className="text-sm text-muted-foreground" role="status">
          Halted: {haltSummary.parked?.length ?? 0} parked, {haltSummary.terminated ?? 0} terminated,{' '}
          {haltSummary.escalated ?? 0} escalated.
        </p>
      )}
      {error !== null && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
