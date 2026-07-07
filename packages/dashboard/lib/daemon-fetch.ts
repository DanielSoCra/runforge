export class DaemonConfigError extends Error {
  constructor() {
    super('DAEMON_URL is not configured');
    this.name = 'DaemonConfigError';
  }
}

export class DaemonAuthError extends Error {
  constructor() {
    super('control token missing or invalid — set RUNFORGE_CONTROL_TOKEN in the dashboard environment');
    this.name = 'DaemonAuthError';
  }
}

export async function daemonFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const base = process.env.DAEMON_URL;
  if (!base) throw new DaemonConfigError();

  const normalizedBase = base.replace(/\/+$/, '');
  const token = process.env.RUNFORGE_CONTROL_TOKEN;
  const res = await fetch(`${normalizedBase}${path}`, {
    ...options,
    headers: {
      'X-Requested-By': 'dashboard',
      ...options?.headers,
      ...(typeof token === 'string' && token !== '' ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: options?.signal ?? AbortSignal.timeout(5000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new DaemonAuthError();
  }

  return res;
}
