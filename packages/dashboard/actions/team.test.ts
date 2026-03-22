import { describe, it, expect, vi, beforeEach } from 'vitest';
import { revalidatePath } from 'next/cache';

const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({
      insert: mockInsert,
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { role: 'admin' } }),
          neq: vi.fn().mockResolvedValue({ data: [{ id: 'other-admin' }] }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
    rpc: mockRpc,
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let createInvitation: typeof import('./team').createInvitation;
let changeRole: typeof import('./team').changeRole;
let removeMember: typeof import('./team').removeMember;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('./team');
  createInvitation = mod.createInvitation;
  changeRole = mod.changeRole;
  removeMember = mod.removeMember;
});

describe('team actions', () => {
  describe('createInvitation', () => {
    it('inserts with pending status', async () => {
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'viewer');
      await createInvitation(formData);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ provider_handle: 'octocat', status: 'pending', invited_by: 'user-123' })
      );
      expect(revalidatePath).toHaveBeenCalledWith('/team');
    });

    it('throws on empty provider_handle', async () => {
      const formData = new FormData();
      formData.append('provider_handle', '');
      formData.append('role', 'admin');

      await expect(createInvitation(formData)).rejects.toThrow('GitHub username is required');
    });

    it('throws on missing provider_handle', async () => {
      const formData = new FormData();
      formData.append('role', 'admin');

      await expect(createInvitation(formData)).rejects.toThrow('GitHub username is required');
    });

    it('throws on invalid role', async () => {
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'superadmin');

      await expect(createInvitation(formData)).rejects.toThrow('Invalid role');
    });

    it('throws on duplicate pending invitation', async () => {
      mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate' } });
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'viewer');

      await expect(createInvitation(formData)).rejects.toThrow('A pending invitation for this user already exists');
    });

    it('throws generic error on insert failure', async () => {
      mockInsert.mockResolvedValueOnce({ error: { code: '42000', message: 'db error' } });
      const formData = new FormData();
      formData.append('provider_handle', 'octocat');
      formData.append('role', 'viewer');

      await expect(createInvitation(formData)).rejects.toThrow('Failed to create invitation');
    });
  });

  describe('changeRole', () => {
    it('calls change_member_role RPC and revalidates', async () => {
      mockRpc.mockResolvedValue({ data: 'ok', error: null });
      await changeRole('member-1', 'viewer');

      expect(mockRpc).toHaveBeenCalledWith('change_member_role', {
        p_member_id: 'member-1',
        p_new_role: 'viewer',
      });
      expect(revalidatePath).toHaveBeenCalledWith('/team');
    });

    it('throws on last_admin response', async () => {
      mockRpc.mockResolvedValue({ data: 'last_admin', error: null });

      await expect(changeRole('member-1', 'viewer')).rejects.toThrow(
        'Cannot demote the last admin'
      );
    });

    it('throws on not_found response', async () => {
      mockRpc.mockResolvedValue({ data: 'not_found', error: null });

      await expect(changeRole('member-1', 'admin')).rejects.toThrow('Member not found');
    });

    it('throws on RPC error', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'connection failed' } });

      await expect(changeRole('member-1', 'admin')).rejects.toThrow(
        'Failed to change member role'
      );
    });
  });

  describe('removeMember', () => {
    it('calls remove_team_member RPC and revalidates', async () => {
      mockRpc.mockResolvedValue({ data: 'ok', error: null });
      await removeMember('member-2');

      expect(mockRpc).toHaveBeenCalledWith('remove_team_member', {
        p_member_id: 'member-2',
      });
      expect(revalidatePath).toHaveBeenCalledWith('/team');
    });

    it('throws on last_admin response', async () => {
      mockRpc.mockResolvedValue({ data: 'last_admin', error: null });

      await expect(removeMember('member-2')).rejects.toThrow(
        'Cannot remove the last admin'
      );
    });

    it('throws on not_found response', async () => {
      mockRpc.mockResolvedValue({ data: 'not_found', error: null });

      await expect(removeMember('member-2')).rejects.toThrow('Member not found');
    });

    it('throws on RPC error', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } });

      await expect(removeMember('member-2')).rejects.toThrow('Failed to remove member');
    });
  });
});
