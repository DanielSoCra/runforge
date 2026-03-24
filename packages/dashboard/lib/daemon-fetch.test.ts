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

  it('passes through additional options like cache', async () => {
    vi.stubEnv('DAEMON_URL', 'http://localhost:9800');
    fetchMock.mockResolvedValueOnce(new Response('ok'));
    const { daemonFetch } = await import('./daemon-fetch');
    await daemonFetch('/status', { cache: 'no-store' });
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store');
  });
});
