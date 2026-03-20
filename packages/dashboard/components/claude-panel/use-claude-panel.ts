'use client';
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'claude-panel-open';
const POLL_INTERVAL = 5_000;

export type RemoteControlState = 'offline' | 'active' | 'failed';

export function useClaudePanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<RemoteControlState>('offline');
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const startSession = useCallback(async () => {
    setIsStarting(true);
    setStartError(null);
    try {
      const res = await fetch('/api/daemon/remote-control/restart', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setStartError(data.error ?? 'Failed to start session');
        setTimeout(() => setStartError(null), 4000);
      }
    } catch {
      setStartError('Daemon unreachable');
      setTimeout(() => setStartError(null), 4000);
    } finally {
      setIsStarting(false);
    }
  }, []);

  // Mount: restore persisted panel state (SSR-safe — localStorage is client-only)
  useEffect(() => {
    setIsOpen(localStorage.getItem(STORAGE_KEY) === 'true');
  }, []);

  // Persist panel open/closed state on every change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch('/api/daemon/status');
        if (!res.ok || !active) return;
        const data = await res.json();
        setSessionUrl(data.remote_control_url ?? null);
        setSessionState(data.remote_control_state ?? 'offline');
      } catch {
        // ignore — panel stays in last known state
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return { isOpen, toggle, sessionUrl, sessionState, startSession, isStarting, startError };
}
