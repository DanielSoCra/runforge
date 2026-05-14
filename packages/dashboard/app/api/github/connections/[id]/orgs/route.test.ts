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
});
