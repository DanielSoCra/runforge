const mocks = vi.hoisted(() => ({
  isDashboardAdmin: vi.fn(),
  readTeamPage: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  isDashboardAdmin: mocks.isDashboardAdmin,
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    team: { readTeamPage: mocks.readTeamPage },
  }),
}));

vi.mock('@/actions/team', () => ({
  changeRole: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock('@/components/invite-form', () => ({
  InviteForm: () => <div>invite form</div>,
}));

vi.mock('@/components/page-error', () => ({
  PageError: () => <div>Failed to load data</div>,
}));

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamPage from './page';

describe('TeamPage', () => {
  beforeEach(() => {
    mocks.isDashboardAdmin.mockReset();
    mocks.readTeamPage.mockReset();
    mocks.isDashboardAdmin.mockResolvedValue(true);
    mocks.readTeamPage.mockResolvedValue({
      ok: true,
      value: {
        members: [
          {
            id: 'member-1',
            role: 'admin',
            granted_at: '2026-05-21T00:00:00.000Z',
            user: {
              email: 'admin@example.com',
              name: 'Admin User',
              image: null,
            },
          },
          {
            id: 'member-2',
            role: 'viewer',
            granted_at: '2026-05-21T00:01:00.000Z',
            user: {
              email: 'viewer@example.com',
              name: '',
              image: null,
            },
          },
        ],
        invitations: [
          {
            id: 'invite-1',
            provider_handle: 'octocat',
            role: 'viewer',
            created_at: '2026-05-21T00:02:00.000Z',
          },
        ],
      },
    });
  });

  it('renders team members and pending invitations from the app-owned store for admins', async () => {
    const jsx = await TeamPage();
    render(jsx);

    expect(mocks.readTeamPage).toHaveBeenCalledWith({
      includePendingInvitations: true,
    });
    expect(screen.getByText('Admin User')).toBeInTheDocument();
    expect(screen.getByText('viewer@example.com')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText('invite form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make viewer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make admin' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('hides admin-only controls for non-admin users', async () => {
    mocks.isDashboardAdmin.mockResolvedValueOnce(false);

    const jsx = await TeamPage();
    render(jsx);

    expect(mocks.readTeamPage).toHaveBeenCalledWith({
      includePendingInvitations: false,
    });
    expect(screen.getByText('Admin User')).toBeInTheDocument();
    expect(screen.queryByText('Pending Invitations')).not.toBeInTheDocument();
    expect(screen.queryByText('invite form')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make viewer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows the page error when the team store is unavailable', async () => {
    mocks.readTeamPage.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'database offline',
    });

    const jsx = await TeamPage();
    render(jsx);

    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
  });
});
