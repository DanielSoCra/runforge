vi.mock('./use-claude-panel', () => ({
  useClaudePanel: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('./context-actions', () => ({
  getContextActions: vi.fn(() => []),
}));

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudePanel } from './claude-panel';
import { useClaudePanel } from './use-claude-panel';

const mockHook = vi.mocked(useClaudePanel);

const baseHook = {
  isOpen: false,
  toggle: vi.fn(),
  sessionUrl: null,
  sessionState: 'offline' as const,
  sessionError: null,
  restarting: false,
  restart: vi.fn(),
};

describe('ClaudePanel', () => {
  beforeEach(() => {
    mockHook.mockReturnValue({ ...baseHook });
  });

  it('renders collapsed tab with status dot', () => {
    render(<ClaudePanel />);
    expect(screen.getByRole('button', { name: /claude/i })).toBeInTheDocument();
    // Status dot is present (grey for offline)
    expect(document.querySelector('[data-state="offline"]')).toBeInTheDocument();
  });

  it('calls toggle when tab is clicked', () => {
    const toggle = vi.fn();
    mockHook.mockReturnValue({ ...baseHook, toggle });
    render(<ClaudePanel />);
    fireEvent.click(screen.getByRole('button', { name: /claude/i }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('shows session URL when open and active', () => {
    mockHook.mockReturnValue({
      ...baseHook,
      isOpen: true,
      sessionUrl: 'https://claude.ai/remote/test',
      sessionState: 'active',
    });
    render(<ClaudePanel />);
    expect(screen.getByText('https://claude.ai/remote/test')).toBeInTheDocument();
  });

  it('shows failed alert when state is failed', () => {
    mockHook.mockReturnValue({ ...baseHook, isOpen: true, sessionState: 'failed' });
    render(<ClaudePanel />);
    expect(screen.getByText(/remote control failed/i)).toBeInTheDocument();
  });

  it('shows error detail in failed alert', () => {
    mockHook.mockReturnValue({
      ...baseHook,
      isOpen: true,
      sessionState: 'failed',
      sessionError: 'Not authenticated',
    });
    render(<ClaudePanel />);
    expect(screen.getByText('Not authenticated')).toBeInTheDocument();
  });

  it('shows Start session button when offline', () => {
    mockHook.mockReturnValue({ ...baseHook, isOpen: true, sessionState: 'offline' });
    render(<ClaudePanel />);
    expect(screen.getByRole('button', { name: /start session/i })).toBeInTheDocument();
  });

  it('calls restart when Start session is clicked', () => {
    const restart = vi.fn();
    mockHook.mockReturnValue({ ...baseHook, isOpen: true, sessionState: 'offline', restart });
    render(<ClaudePanel />);
    fireEvent.click(screen.getByRole('button', { name: /start session/i }));
    expect(restart).toHaveBeenCalledOnce();
  });
});
