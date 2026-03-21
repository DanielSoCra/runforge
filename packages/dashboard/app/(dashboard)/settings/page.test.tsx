import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockIsAdmin } = vi.hoisted(() => ({
  mockIsAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { concurrency_limit: 3 }, error: null }),
      }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
  }),
}));
vi.mock('@/actions/settings', () => ({ updateGlobalSettings: vi.fn() }));
vi.mock('@/components/page-error', () => ({ PageError: () => <div>Error</div> }));
vi.mock('@/components/github-connections-section', () => ({
  GitHubConnectionsSection: () => <div>connections</div>,
}));
vi.mock('@/lib/auth', () => ({ isAdmin: mockIsAdmin }));

beforeEach(() => {
  cleanup();
});

describe('SettingsPage', () => {
  it('shows access denied for non-admin users', async () => {
    mockIsAdmin.mockResolvedValue(false);
    const { default: SettingsPage } = await import('./page');
    const result = await SettingsPage();
    render(result);
    expect(screen.getByText('Admin access required to view settings.')).toBeInTheDocument();
    expect(screen.queryByText('Save Settings')).not.toBeInTheDocument();
  });

  it('shows settings form for admin users', async () => {
    mockIsAdmin.mockResolvedValue(true);
    const { default: SettingsPage } = await import('./page');
    const result = await SettingsPage();
    render(result);
    expect(screen.getByText('Save Settings')).toBeInTheDocument();
  });
});
