import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getOrigin, requireAdmin, requireUser, isAdmin, isAuthDisabled } from './auth';

describe('getOrigin', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns NEXT_PUBLIC_SITE_URL when set', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dashboard.example.com');
    expect(getOrigin()).toBe('https://dashboard.example.com');
  });

  it('strips trailing slash from NEXT_PUBLIC_SITE_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dashboard.example.com/');
    expect(getOrigin()).toBe('https://dashboard.example.com');
  });

  it('throws in production when NEXT_PUBLIC_SITE_URL is not set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(() => getOrigin()).toThrow('NEXT_PUBLIC_SITE_URL environment variable is required in production');
  });

  it('ignores X-Forwarded-Host header even when provided (regression: SEC-4)', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dashboard.example.com');
    const maliciousRequest = new Request('http://internal:3000/auth/login', {
      headers: {
        'x-forwarded-host': 'evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    });
    // Must return NEXT_PUBLIC_SITE_URL, never the attacker-controlled header
    expect(getOrigin(maliciousRequest)).toBe('https://dashboard.example.com');
  });

  it('uses request.url origin in development when NEXT_PUBLIC_SITE_URL is not set', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const request = new Request('http://localhost:3000/auth/callback');
    expect(getOrigin(request)).toBe('http://localhost:3000');
  });

  it('never uses X-Forwarded-Host even in development (regression: SEC-4)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const maliciousRequest = new Request('http://localhost:3000/auth/login', {
      headers: {
        'x-forwarded-host': 'evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    });
    // Must return localhost, never the attacker-controlled header
    expect(getOrigin(maliciousRequest)).toBe('http://localhost:3000');
  });

  it('falls back to localhost:3000 in development with no request', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(getOrigin()).toBe('http://localhost:3000');
  });

  it('reads NEXT_PUBLIC_SITE_URL not SITE_URL (regression: INFRA-06 #361)', () => {
    // Operators set NEXT_PUBLIC_SITE_URL per .env examples; the old SITE_URL
    // variable should NOT be read, even if accidentally present.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://correct.example.com');
    vi.stubEnv('SITE_URL', 'https://wrong.example.com');
    expect(getOrigin()).toBe('https://correct.example.com');
  });
});

/** Helper: build a mock SupabaseClient with configurable auth and query responses. */
function mockSupabase({
  user = { id: 'user-123' } as { id: string } | null,
  member = { role: 'admin' } as { role: string } | null,
  queryError = null as { code: string; message: string } | null,
} = {}) {
  const single = vi.fn().mockResolvedValue({ data: member, error: queryError });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: vi.fn().mockReturnValue({ select, eq }),
  } as any;
}

describe('requireAdmin', () => {
  it('returns the user when they are an admin', async () => {
    const supabase = mockSupabase({ user: { id: 'u1' }, member: { role: 'admin' } });
    const user = await requireAdmin(supabase);
    expect(user).toEqual({ id: 'u1' });
    expect(supabase.from).toHaveBeenCalledWith('team_members');
  });

  it('throws Unauthorized when no user session exists', async () => {
    const supabase = mockSupabase({ user: null });
    await expect(requireAdmin(supabase)).rejects.toThrow('Unauthorized');
  });

  it('throws Admin access required when user is a viewer', async () => {
    const supabase = mockSupabase({ member: { role: 'viewer' } });
    await expect(requireAdmin(supabase)).rejects.toThrow('Admin access required');
  });

  it('throws Admin access required when no team_members row exists (PGRST116)', async () => {
    const supabase = mockSupabase({
      member: null,
      queryError: { code: 'PGRST116', message: 'not found' },
    });
    await expect(requireAdmin(supabase)).rejects.toThrow('Admin access required');
  });

  it('logs non-PGRST116 query errors and still rejects non-admin', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = mockSupabase({
      member: null,
      queryError: { code: '42P01', message: 'relation does not exist' },
    });
    await expect(requireAdmin(supabase)).rejects.toThrow('Admin access required');
    expect(consoleSpy).toHaveBeenCalledWith(
      '[auth] team_members query failed:',
      'relation does not exist',
    );
    consoleSpy.mockRestore();
  });
});

describe('requireUser', () => {
  it('returns the user when they are an admin', async () => {
    const supabase = mockSupabase({ user: { id: 'u1' }, member: { role: 'admin' } });
    const user = await requireUser(supabase);
    expect(user).toEqual({ id: 'u1' });
  });

  it('returns the user when they are a viewer', async () => {
    const supabase = mockSupabase({ user: { id: 'u2' }, member: { role: 'viewer' } });
    const user = await requireUser(supabase);
    expect(user).toEqual({ id: 'u2' });
  });

  it('throws Unauthorized when no user session exists', async () => {
    const supabase = mockSupabase({ user: null });
    await expect(requireUser(supabase)).rejects.toThrow('Unauthorized');
  });

  it('throws Access denied when no team_members row exists (PGRST116)', async () => {
    const supabase = mockSupabase({
      member: null,
      queryError: { code: 'PGRST116', message: 'not found' },
    });
    await expect(requireUser(supabase)).rejects.toThrow('Access denied');
  });

  it('logs non-PGRST116 query errors and still rejects non-member', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = mockSupabase({
      member: null,
      queryError: { code: '42P01', message: 'relation does not exist' },
    });
    await expect(requireUser(supabase)).rejects.toThrow('Access denied');
    expect(consoleSpy).toHaveBeenCalledWith(
      '[auth] team_members query failed:',
      'relation does not exist',
    );
    consoleSpy.mockRestore();
  });
});

describe('requireUser — AUTH_DISABLED bypass', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  it('returns synthetic admin without calling supabase when AUTH_DISABLED=true', async () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    const supabase = mockSupabase({ user: null });
    const user = await requireUser(supabase);
    expect(user.id).toBe('00000000-0000-0000-0000-000000000000');
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it('still enforces auth when AUTH_DISABLED is not set', async () => {
    const supabase = mockSupabase({ user: null });
    await expect(requireUser(supabase)).rejects.toThrow('Unauthorized');
  });
});

describe('isAdmin', () => {
  it('returns true when user is an admin', async () => {
    const supabase = mockSupabase({ member: { role: 'admin' } });
    expect(await isAdmin(supabase)).toBe(true);
  });

  it('returns false when no user session exists', async () => {
    const supabase = mockSupabase({ user: null });
    expect(await isAdmin(supabase)).toBe(false);
  });

  it('returns false when user is a viewer', async () => {
    const supabase = mockSupabase({ member: { role: 'viewer' } });
    expect(await isAdmin(supabase)).toBe(false);
  });

  it('returns false when no team_members row exists (PGRST116)', async () => {
    const supabase = mockSupabase({
      member: null,
      queryError: { code: 'PGRST116', message: 'not found' },
    });
    expect(await isAdmin(supabase)).toBe(false);
  });

  it('logs non-PGRST116 query errors and returns false', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = mockSupabase({
      member: null,
      queryError: { code: '42P01', message: 'relation does not exist' },
    });
    expect(await isAdmin(supabase)).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[auth] team_members query failed:',
      'relation does not exist',
    );
    consoleSpy.mockRestore();
  });

  it('returns false when getUser rejects (never-throws contract)', async () => {
    const supabase = {
      auth: { getUser: vi.fn().mockRejectedValue(new Error('network down')) },
      from: vi.fn(),
    } as any;
    // isAdmin contract: never throws, even on network errors
    expect(await isAdmin(supabase)).toBe(false);
  });

  it('returns false when from() chain rejects (never-throws contract)', async () => {
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockRejectedValue(new Error('connection reset')),
          }),
        }),
      }),
    } as any;
    expect(await isAdmin(supabase)).toBe(false);
  });
});

describe('isAuthDisabled', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  it('returns true when AUTH_DISABLED is "true"', () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    expect(isAuthDisabled()).toBe(true);
  });

  it('returns false when AUTH_DISABLED is not set', () => {
    expect(isAuthDisabled()).toBe(false);
  });

  it('returns false when AUTH_DISABLED is "1" (only exact "true" is accepted)', () => {
    vi.stubEnv('AUTH_DISABLED', '1');
    expect(isAuthDisabled()).toBe(false);
  });

  it('returns false when AUTH_DISABLED is "false"', () => {
    vi.stubEnv('AUTH_DISABLED', 'false');
    expect(isAuthDisabled()).toBe(false);
  });

  it('returns false in production even when AUTH_DISABLED is "true" (regression: SEC-29)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_DISABLED', 'true');
    expect(isAuthDisabled()).toBe(false);
  });
});

describe('requireAdmin — AUTH_DISABLED bypass', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  it('returns synthetic admin without calling supabase when AUTH_DISABLED=true', async () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    const supabase = mockSupabase({ user: null }); // would normally reject
    const user = await requireAdmin(supabase);
    expect(user.id).toBe('00000000-0000-0000-0000-000000000000');
    expect(user.email).toBe('admin@localhost');
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it('still enforces auth when AUTH_DISABLED is not set', async () => {
    const supabase = mockSupabase({ user: null });
    await expect(requireAdmin(supabase)).rejects.toThrow('Unauthorized');
  });
});

describe('isAdmin — AUTH_DISABLED bypass', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_DISABLED;
  });

  it('returns true without calling supabase when AUTH_DISABLED=true', async () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    const supabase = mockSupabase({ user: null }); // would normally return false
    expect(await isAdmin(supabase)).toBe(true);
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it('still checks auth when AUTH_DISABLED is not set', async () => {
    const supabase = mockSupabase({ user: null });
    expect(await isAdmin(supabase)).toBe(false);
  });
});
