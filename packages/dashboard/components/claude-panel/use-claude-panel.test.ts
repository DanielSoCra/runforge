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
      vi.advanceTimersByTime(100); // trigger initial fetch
      await Promise.resolve();
    });
    expect(result.current.sessionUrl).toBe('https://claude.ai/remote/test');
    expect(result.current.sessionState).toBe('active');
  });

  it('re-polls every 5 seconds', async () => {
    renderHook(() => useClaudePanel());
    await act(async () => {
      vi.advanceTimersByTime(5100);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2); // initial + one poll
  });
});
