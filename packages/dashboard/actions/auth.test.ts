import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDashboardAuth: vi.fn(),
  signOut: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  }),
}));

vi.mock('@/lib/auth/better-auth', () => ({
  getDashboardAuth: mocks.getDashboardAuth,
}));

vi.mock('next/headers', () => ({
  headers: mocks.headers,
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

describe('signOut', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getDashboardAuth.mockReset();
    mocks.signOut.mockReset();
    mocks.headers.mockReset();
    mocks.redirect.mockClear();
    mocks.getDashboardAuth.mockReturnValue({
      api: { signOut: mocks.signOut },
    });
    mocks.signOut.mockResolvedValue({ success: true });
    mocks.headers.mockResolvedValue(
      new Headers({ cookie: 'runforge.session_token=token' }),
    );
  });

  it('invalidates the Better Auth session and redirects to login', async () => {
    const { signOut } = await import('./auth');

    await expect(signOut()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(mocks.getDashboardAuth).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    const input = mocks.signOut.mock.calls[0]?.[0] as { headers: Headers };
    expect(input.headers.get('cookie')).toBe('runforge.session_token=token');
  });
});
