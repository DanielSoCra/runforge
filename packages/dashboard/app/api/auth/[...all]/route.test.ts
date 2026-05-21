import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDashboardAuth: vi.fn(),
  handler: vi.fn(),
}));

vi.mock('@/lib/auth/better-auth', () => ({
  getDashboardAuth: mocks.getDashboardAuth,
}));

describe('/api/auth/[...all]', () => {
  beforeEach(() => {
    mocks.handler.mockReset();
    mocks.getDashboardAuth.mockReset();
    mocks.handler.mockImplementation(
      async () => new Response('ok', { status: 202 }),
    );
    mocks.getDashboardAuth.mockReturnValue({ handler: mocks.handler });
  });

  it('runs in the Node runtime', async () => {
    const { runtime } = await import('./route');

    expect(runtime).toBe('nodejs');
  });

  it('delegates GET requests to the Better Auth handler', async () => {
    const { GET } = await import('./route');
    const request = new Request('http://localhost:3000/api/auth/get-session');

    const response = await GET(request);

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe('ok');
    expect(mocks.getDashboardAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handler).toHaveBeenCalledWith(request);
  });

  it('delegates POST requests to the Better Auth handler', async () => {
    const { POST } = await import('./route');
    const request = new Request('http://localhost:3000/api/auth/sign-in/social', {
      method: 'POST',
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe('ok');
    expect(mocks.getDashboardAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handler).toHaveBeenCalledWith(request);
  });
});
