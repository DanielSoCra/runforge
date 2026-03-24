import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock child client components to avoid browser dependency errors
vi.mock('@/components/sidebar', () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock('@/components/realtime-provider', () => ({ RealtimeProvider: () => null }));
vi.mock('@/components/ui/tooltip', () => ({ TooltipProvider: ({ children }: any) => children }));
vi.mock('@/components/claude-panel/claude-panel', () => ({ ClaudePanel: () => null }));
vi.mock('@/components/sign-out-button', () => ({ SignOutButton: () => <button>Sign out</button> }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
}));

import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue({} as any);
});

describe('DashboardLayout', () => {
  it('renders children when requireUser succeeds', async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: 'user-1' } as any);
    const { default: DashboardLayout } = await import('./layout');
    const tree = await DashboardLayout({ children: <div data-testid="child">Hello</div> });
    render(tree);
    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('renders access denied with sign-out button when requireUser throws', async () => {
    vi.mocked(requireUser).mockRejectedValue(
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
