import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('daemonFetch', () => {
  it('throws DaemonConfigError when DAEMON_URL is undefined', async () => {
    vi.stubEnv('DAEMON_URL', '');
    const { daemonFetch, DaemonConfigError } = await import('./daemon-fetch');
    await expect(daemonFetch('/status')).rejects.toThrow(DaemonConfigError);
  });

  it('calls fetch with correct URL', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/status');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9800/status', expect.any(Object));
  });

  it('strips trailing slash from DAEMON_URL', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800/');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/pause');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9800/pause', expect.any(Object));
  });

  it('adds X-Requested-By header by default', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/pause', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ 'X-Requested-By': 'dashboard' }),
    }));
  });

  it('defaults to 5000ms timeout', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/pause');
    const signal = fetchMock.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('allows caller to override signal', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const customSignal = AbortSignal.timeout(3000);
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/status', { signal: customSignal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(customSignal);
  });

  it('adds Authorization: Bearer from RUNFORGE_CONTROL_TOKEN on GET when set', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    vi.stubEnv('RUNFORGE_CONTROL_TOKEN', 'secret-token');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/status');
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ 'Authorization': 'Bearer secret-token' }),
    }));
  });

  it('adds Authorization: Bearer from RUNFORGE_CONTROL_TOKEN on POST when set', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    vi.stubEnv('RUNFORGE_CONTROL_TOKEN', 'secret-token');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/pause', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ 'Authorization': 'Bearer secret-token' }),
    }));
  });

  it('omits Authorization when RUNFORGE_CONTROL_TOKEN is unset', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    vi.stubEnv('RUNFORGE_CONTROL_TOKEN', '');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/status');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('does not allow callers to override Authorization', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    vi.stubEnv('RUNFORGE_CONTROL_TOKEN', 'secret-token');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/status', { headers: { Authorization: 'Bearer attacker-token' } });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });

  it('throws DaemonAuthError when daemon responds with 401', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const { daemonFetch, DaemonAuthError } = await import('./daemon-fetch');
    await expect(daemonFetch('/status')).rejects.toThrow(DaemonAuthError);
  });

  it('throws DaemonAuthError when daemon responds with 403', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const { daemonFetch, DaemonAuthError } = await import('./daemon-fetch');
    await expect(daemonFetch('/status')).rejects.toThrow(DaemonAuthError);
  });
});

