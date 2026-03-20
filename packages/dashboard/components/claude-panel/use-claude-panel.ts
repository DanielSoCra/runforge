'use client';
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'claude-panel-open';
const POLL_INTERVAL = 5_000;

export type RemoteControlState = 'offline' | 'active' | 'failed';

export function useClaudePanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<RemoteControlState>('offline');

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
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

  return { isOpen, toggle, sessionUrl, sessionState };
}
