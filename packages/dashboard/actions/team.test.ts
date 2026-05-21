import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';

const mocks = vi.hoisted(() => ({
  requireDashboardAdmin: vi.fn(),
  createInvitation: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardAdmin: mocks.requireDashboardAdmin,
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    team: {
      createInvitation: mocks.createInvitation,
      changeMemberRole: mocks.changeMemberRole,
      removeMember: mocks.removeMember,
    },
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { changeRole, createInvitation, removeMember } from './team';

describe('team actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardAdmin.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
    });
    mocks.createInvitation.mockResolvedValue({ ok: true, value: undefined });
    mocks.changeMemberRole.mockResolvedValue({ ok: true, value: undefined });
    mocks.removeMember.mockResolvedValue({ ok: true, value: undefined });
  });

  it('does not mutate team state when the admin gate rejects', async () => {
    mocks.requireDashboardAdmin.mockRejectedValueOnce(
      new Error('Admin access required'),
    );

    await expect(changeRole('member-1', 'viewer')).rejects.toThrow(
      'Admin access required',
    );
    expect(mocks.changeMemberRole).not.toHaveBeenCalled();
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });

  describe('createInvitation', () => {
    it('creates a pending invitation through the app-owned team store', async () => {
      const formData = new FormData();
      formData.append('provider_handle', ' octocat ');
      formData.append('role', 'viewer');

      await createInvitation(formData);

      expect(mocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.createInvitation).toHaveBeenCalledWith({
        providerHandle: 'octocat',
        role: 'viewer',
        invitedBy: 'admin-1',
      });
      expect(revalidatePath).toHaveBeenCalledWith('/team');
    });

    it('throws on empty provider_handle before touching the store', async () => {
      const formData = new FormData();
      formData.append('provider_handle', '');
      formData.append('role', 'admin');

      await expect(createInvitation(formData)).rejects.toThrow(
        'GitHub username is required',
      );
      expect(mocks.createInvitation).not.toHaveBeenCalled();
    });

    it('throws on missing provider_handle before touching the store', async () => {
      const formData = new FormData();
      formData.append('role', 'admin');

      await expect(createInvitation(formData)).rejects.toThrow(
        'GitHub username is required',
      );
      expect(mocks.createInvitation).not.toHaveBeenCalled();
    });

    it('throws on invalid role before touching the store', async () => {
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'superadmin');

      await expect(createInvitation(formData)).rejects.toThrow('Invalid role');
      expect(mocks.createInvitation).not.toHaveBeenCalled();
    });

    it('throws on duplicate pending invitation', async () => {
      mocks.createInvitation.mockResolvedValueOnce({
        ok: false,
        error: 'conflict',
        message: 'duplicate',
      });
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'viewer');

      await expect(createInvitation(formData)).rejects.toThrow(
        'A pending invitation for this user already exists',
      );
    });

    it('throws generic error when the team store cannot create the invitation', async () => {
      mocks.createInvitation.mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db offline',
      });
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'viewer');

      await expect(createInvitation(formData)).rejects.toThrow(
        'Failed to create invitation',
      );
    });
  });

  describe('changeRole', () => {
    it('changes a member role through the app-owned team store and revalidates', async () => {
      await changeRole('member-1', 'viewer');

      expect(mocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.changeMemberRole).toHaveBeenCalledWith('member-1', 'viewer');
      expect(revalidatePath).toHaveBeenCalledWith('/team');
    });

    it('throws on last-admin conflict', async () => {
      mocks.changeMemberRole.mockResolvedValueOnce({
        ok: false,
        error: 'conflict',
        message: 'last admin',
      });

      await expect(changeRole('member-1', 'viewer')).rejects.toThrow(
        'Cannot demote the last admin',
      );
    });

    it('throws on not-found response', async () => {
      mocks.changeMemberRole.mockResolvedValueOnce({
        ok: false,
        error: 'not-found',
        message: 'missing',
      });

      await expect(changeRole('member-1', 'admin')).rejects.toThrow(
        'Member not found',
      );
    });

    it('throws on store failure', async () => {
      mocks.changeMemberRole.mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db offline',
      });

      await expect(changeRole('member-1', 'admin')).rejects.toThrow(
        'Failed to change member role',
      );
    });
  });

  describe('removeMember', () => {
    it('removes a member through the app-owned team store and revalidates', async () => {
      await removeMember('member-2');

      expect(mocks.requireDashboardAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.removeMember).toHaveBeenCalledWith('member-2');
      expect(revalidatePath).toHaveBeenCalledWith('/team');
    });

    it('throws on last-admin conflict', async () => {
      mocks.removeMember.mockResolvedValueOnce({
        ok: false,
        error: 'conflict',
        message: 'last admin',
      });

      await expect(removeMember('member-2')).rejects.toThrow(
        'Cannot remove the last admin',
      );
    });

    it('throws on not-found response', async () => {
      mocks.removeMember.mockResolvedValueOnce({
        ok: false,
        error: 'not-found',
        message: 'missing',
      });

      await expect(removeMember('member-2')).rejects.toThrow('Member not found');
    });

    it('throws on store failure', async () => {
      mocks.removeMember.mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'db offline',
      });

      await expect(removeMember('member-2')).rejects.toThrow(
        'Failed to remove member',
      );
    });
  });
});
