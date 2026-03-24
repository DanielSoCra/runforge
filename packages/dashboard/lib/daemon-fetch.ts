export class DaemonConfigError extends Error {
  constructor() {
    super('DAEMON_URL is not configured');
    this.name = 'DaemonConfigError';
  }
}

export async function daemonFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const base = process.env.DAEMON_URL;
  if (!base) throw new DaemonConfigError();

  const normalizedBase = base.replace(/\/+$/, '');
  return fetch(`${normalizedBase}${path}`, {
    ...options,
    headers: {
      'X-Requested-By': 'dashboard',
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(5000),
  });
}
