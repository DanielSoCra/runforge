import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClaudePanel } from './use-claude-panel';

// Mock fetch
global.fetch = vi.fn();

describe('useClaudePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        remote_control_state: 'active',
        remote_control_url: 'https://claude.ai/remote/test',
      }),
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts collapsed by default', () => {
    const { result } = renderHook(() => useClaudePanel());
    expect(result.current.isOpen).toBe(false);
  });

  it('toggle opens the panel', () => {
    const { result } = renderHook(() => useClaudePanel());
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
  });

  it('persists open state to localStorage', () => {
    const { result } = renderHook(() => useClaudePanel());
    act(() => result.current.toggle());
    expect(localStorage.getItem('claude-panel-open')).toBe('true');
  });

  it('polls /api/daemon/status and exposes url and state', async () => {
    const { result } = renderHook(() => useClaudePanel());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.sessionUrl).toBe('https://claude.ai/remote/test');
    expect(result.current.sessionState).toBe('active');
  });

  it('re-polls every 5 seconds', async () => {
    renderHook(() => useClaudePanel());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(fetch).toHaveBeenCalledTimes(2); // initial + one poll
  });

  it('startSession() calls POST /api/daemon/remote-control/restart', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ remote_control_state: 'offline', remote_control_url: null }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ restarted: true }) } as Response);

    const { result } = renderHook(() => useClaudePanel());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // initial poll

    await act(async () => { await result.current.startSession(); });

    expect(fetch).toHaveBeenCalledWith('/api/daemon/remote-control/restart', { method: 'POST' });
  });

  it('startSession() sets isStarting=true while in flight, false after', async () => {
    let resolveRestart!: () => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ remote_control_state: 'offline', remote_control_url: null }) } as Response)
      .mockImplementationOnce(() => new Promise<Response>((res) => {
        resolveRestart = () => res({ ok: true, json: async () => ({ restarted: true }) } as Response);
      }));

    const { result } = renderHook(() => useClaudePanel());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    let startPromise!: Promise<void>;
    act(() => { startPromise = result.current.startSession(); });
    expect(result.current.isStarting).toBe(true);

    await act(async () => { resolveRestart(); await startPromise; });
    expect(result.current.isStarting).toBe(false);
  });

  it('startSession() sets startError when fetch fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ remote_control_state: 'offline', remote_control_url: null }) } as Response)
      .mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useClaudePanel());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    await act(async () => { await result.current.startSession(); });

    expect(result.current.startError).toBe('Daemon unreachable');
  });
});
