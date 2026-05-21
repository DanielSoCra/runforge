import type { ReactNode } from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock child client components to avoid browser dependency errors
vi.mock('@/components/sidebar', () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock('@/components/realtime-provider', () => ({ RealtimeProvider: () => null }));
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/claude-panel/claude-panel', () => ({ ClaudePanel: () => null }));
vi.mock('@/components/sign-out-button', () => ({ SignOutButton: () => <button>Sign out</button> }));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardUser: vi.fn(),
}));

import { requireDashboardUser } from '@/lib/auth/require-session';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardLayout', () => {
  it('renders children when requireDashboardUser succeeds', async () => {
    vi.mocked(requireDashboardUser).mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'user@example.test',
        name: 'User',
        role: 'viewer',
      },
      session: {},
    });
    const { default: DashboardLayout } = await import('./layout');
    const tree = await DashboardLayout({ children: <div data-testid="child">Hello</div> });
    render(tree);
    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('renders access denied with sign-out button when requireDashboardUser throws', async () => {
    vi.mocked(requireDashboardUser).mockRejectedValue(
      new Error('Access denied — ask an admin to invite you'),
    );
    const { default: DashboardLayout } = await import('./layout');
    const tree = await DashboardLayout({ children: <div>Should not appear</div> });
    render(tree);
    expect(screen.getByText(/Access Denied/)).toBeDefined();
    expect(screen.getByText('Sign out')).toBeDefined();
    expect(screen.queryByText('Should not appear')).toBeNull();
  });
});
