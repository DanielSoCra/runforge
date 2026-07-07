import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export class ControlBindError extends Error {}

/**
 * IPv4 loopback check for the daemon's host contract. Only 127.0.0.0/8 is
 * considered loopback; ::1 and hostnames are not loopback here because the
 * daemon binds only IPv4 addresses.
 */
export function isLoopbackHost(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127';
}

export function assertBindAllowed(host: string, token: string | undefined): void {
  const hasToken = typeof token === 'string' && token !== '';
  if (!isLoopbackHost(host) && !hasToken) {
    throw new ControlBindError(
      `Non-loopback control bind (${host}) requires RUNFORGE_CONTROL_TOKEN. ` +
        `Set the token or bind 127.0.0.1 to start.`,
    );
  }
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

export function checkAuthorization(
  authorizationHeader: string | string[] | undefined,
  token: string,
): AuthResult {
  const header = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;

  if (header === undefined) {
    return { ok: false, status: 401, error: 'Authorization header required' };
  }

  const parts = header.split(' ');
  if (parts[0]?.toLowerCase() !== 'bearer' || parts.length !== 2) {
    return { ok: false, status: 403, error: 'Invalid control token' };
  }

  const provided = parts[1];
  if (provided === undefined) {
    return { ok: false, status: 403, error: 'Invalid control token' };
  }

  const providedBuf = Buffer.from(provided);
  const tokenBuf = Buffer.from(token);

  if (providedBuf.length !== tokenBuf.length) {
    return { ok: false, status: 403, error: 'Invalid control token' };
  }

  try {
    if (timingSafeEqual(providedBuf, tokenBuf)) {
      return { ok: true };
    }
    return { ok: false, status: 403, error: 'Invalid control token' };
  } catch {
    return { ok: false, status: 403, error: 'Invalid control token' };
  }
}
