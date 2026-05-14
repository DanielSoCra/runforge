import { describe, expect, it, vi, beforeEach } from 'vitest';

function mockSupabaseUnauthenticated() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(),
  };
}

function mockSupabaseNonAdmin() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-2' } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { role: 'viewer' }, error: null }),
    }),
  };
}

function mockSupabaseAdminWithOrgs(result: {
  data: Array<{ id: string; login: string; name: string | null; avatar_url: string | null; is_selected: boolean }> | null;
  error: { message: string } | null;
}) {
  const orgsOrder = vi.fn().mockResolvedValue(result);
  const orgsEq = vi.fn().mockReturnValue({ order: orgsOrder });
  const orgsSelect = vi.fn().mockReturnValue({ eq: orgsEq });
  const from = vi.fn((table: string) => {
    if (table === 'team_members') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
      };
    }
    if (table === 'github_orgs') {
      return {
        select: orgsSelect,
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });

  return {
    client: {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from,
    },
    orgsEq,
    orgsOrder,
    orgsSelect,
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

async function getCreateClient() {
  const { createClient } = await import('@/lib/supabase/server');
  return createClient as ReturnType<typeof vi.fn>;
}

const paramsPromise = (id = 'conn-1') => Promise.resolve({ id });

describe('GET /api/github/connections/[id]/orgs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns 401 when user is not authenticated (#549)', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseUnauthenticated());
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as any, { params: paramsPromise() });

    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    const createClient = await getCreateClient();
    createClient.mockResolvedValueOnce(mockSupabaseNonAdmin());
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as any, { params: paramsPromise() });

    expect(res.status).toBe(403);
  });

  it('returns 500 when org lookup fails (#576)', async () => {
    const createClient = await getCreateClient();
    const supabase = mockSupabaseAdminWithOrgs({
      data: null,
      error: { message: 'db unavailable' },
    });
    createClient.mockResolvedValueOnce(supabase.client);
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as any, {
      params: paramsPromise('conn-500'),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to fetch organizations' });
    expect(supabase.orgsEq).toHaveBeenCalledWith('connection_id', 'conn-500');
    expect(supabase.orgsOrder).toHaveBeenCalledWith('login');
  });

  it('returns selected organizations for the requested connection (#576)', async () => {
    const orgs = [
      {
        id: 'org-1',
        login: 'acme',
        name: 'Acme',
        avatar_url: 'https://example.com/acme.png',
        is_selected: true,
      },
      {
        id: 'org-2',
        login: 'tools',
        name: null,
        avatar_url: null,
        is_selected: false,
      },
    ];
    const createClient = await getCreateClient();
    const supabase = mockSupabaseAdminWithOrgs({ data: orgs, error: null });
    createClient.mockResolvedValueOnce(supabase.client);
    const { GET } = await import('./route.js');

    const res = await GET(new Request('http://localhost') as any, {
      params: paramsPromise('conn-200'),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(orgs);
    expect(supabase.orgsSelect).toHaveBeenCalledWith('id, login, name, avatar_url, is_selected');
    expect(supabase.orgsEq).toHaveBeenCalledWith('connection_id', 'conn-200');
    expect(supabase.orgsOrder).toHaveBeenCalledWith('login');
  });
});
