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

describe('ClaudePanel', () => {
  beforeEach(() => {
    mockHook.mockReturnValue({
      isOpen: false,
      toggle: vi.fn(),
      sessionUrl: null,
      sessionState: 'offline',
    });
  });

  it('renders collapsed tab with status dot', () => {
    render(<ClaudePanel />);
    expect(screen.getByRole('button', { name: /claude/i })).toBeInTheDocument();
    // Status dot is present (grey for offline)
    expect(document.querySelector('[data-state="offline"]')).toBeInTheDocument();
  });

  it('calls toggle when tab is clicked', () => {
    const toggle = vi.fn();
    mockHook.mockReturnValue({ isOpen: false, toggle, sessionUrl: null, sessionState: 'offline' });
    render(<ClaudePanel />);
    fireEvent.click(screen.getByRole('button', { name: /claude/i }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('shows session URL when open and active', () => {
    mockHook.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      sessionUrl: 'https://claude.ai/remote/test',
      sessionState: 'active',
    });
    render(<ClaudePanel />);
    expect(screen.getByText('https://claude.ai/remote/test')).toBeInTheDocument();
  });

  it('shows failed alert when state is failed', () => {
    mockHook.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      sessionUrl: null,
      sessionState: 'failed',
    });
    render(<ClaudePanel />);
    expect(screen.getByText(/remote control failed/i)).toBeInTheDocument();
  });
});
