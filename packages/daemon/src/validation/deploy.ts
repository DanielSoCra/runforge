// src/validation/deploy.ts
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { runCommand } from '../lib/process.js';
import { ok, err, type Result } from '../lib/result.js';
import { validateGate1Command } from './gates.js';

/**
 * SSRF-blocked patterns for health check URLs.
 * Allows loopback (localhost/127.x.x.x) since health checks legitimately
 * target the locally-deployed service. Blocks cloud metadata, link-local,
 * and other private ranges that a health check should never reach.
 */
const HEALTH_CHECK_BLOCKED_HOSTNAME_PATTERNS = [
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // Link-local / cloud metadata
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // RFC 1918 Class B
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // RFC 1918 Class C
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // CGNAT 100.64.0.0/10
  /^0\.0\.0\.0$/, // Unspecified (binds all interfaces on Linux)
  /^\[::ffff:a9fe:[0-9a-f]{1,4}\]$/i, // IPv6-mapped 169.254.x.x
  /^\[fe[89ab][0-9a-f]:[0-9a-f:]*\]$/i, // IPv6 link-local
  /^\[fd[0-9a-f]{2}:[0-9a-f:]*\]$/i, // IPv6 ULA
  /^\[fc[0-9a-f]{2}:[0-9a-f:]*\]$/i, // IPv6 ULA
  /^\[::\]$/, // IPv6 unspecified
];

/**
 * Validates a health check URL is not targeting dangerous internal endpoints.
 * Unlike webhook validation, allows loopback and permits http (health checks
 * commonly use plain http on localhost).
 */
export function validateHealthCheckUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `scheme '${parsed.protocol}' not allowed (only http/https)`;
  }
  const hostname = parsed.hostname;
  for (const pattern of HEALTH_CHECK_BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return `hostname '${hostname}' is a blocked internal address`;
    }
  }
  return null;
}

/**
 * Checks whether a resolved IP is in a dangerous range for health checks.
 * Allows loopback (127.x.x.x, ::1) but blocks cloud metadata, link-local,
 * and other private networks.
 */
export function isBlockedHealthCheckIP(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');

  // Handle IPv6-mapped IPv4 in dotted notation (e.g. ::ffff:169.254.169.254)
  const v4Mapped = bare.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (v4Mapped) {
    return isBlockedHealthCheckIP(v4Mapped[1]!);
  }

  // Allow loopback
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return false;
  if (bare === '::1') return false;

  // Block link-local (cloud metadata), RFC 1918, CGNAT, unspecified, IPv6 ULA/link-local
  const BLOCKED_IP_PATTERNS = [
    /^169\.254\.\d{1,3}\.\d{1,3}$/,
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
    /^192\.168\.\d{1,3}\.\d{1,3}$/,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // CGNAT
    /^0\.0\.0\.0$/,
    /^::$/,
    /^fe[89ab][0-9a-f]:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fc[0-9a-f]{2}:/i,
  ];
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(bare)) return true;
  }
  return false;
}

/**
 * DNS rebinding defense for health check URLs. Resolves hostname and validates
 * the resolved IP is not targeting dangerous internal endpoints.
 */
export async function validateHealthCheckResolvedIP(
  raw: string,
): Promise<string | null> {
  const parsed = new URL(raw);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname)) {
    return isBlockedHealthCheckIP(hostname)
      ? `resolved IP '${hostname}' is a blocked internal address`
      : null;
  }

  try {
    const results = await lookup(hostname, { all: true });
    for (const { address } of results) {
      if (isBlockedHealthCheckIP(address)) {
        return `resolved IP '${address}' for hostname '${hostname}' is a blocked internal address`;
      }
    }
    return null;
  } catch (dnsErr) {
    return `DNS resolution failed for '${hostname}': ${(dnsErr as Error).message}`;
  }
}

export interface DeployConfig {
  deployCommand: string;
  healthCheckUrl: string;
  healthCheckIntervalMs: number;
  deployTimeoutMs: number;
  maxAttempts: number;
  cwd: string;
}

export interface DeployResult {
  status: 'healthy' | 'timeout' | 'failed';
  attempts: number;
}

export async function runDeploy(
  config: DeployConfig,
): Promise<Result<DeployResult>> {
  const validationError = validateGate1Command(config.deployCommand);
  if (validationError) {
    return err(new Error(validationError));
  }

  // SSRF protection: validate health check URL before deploying
  const urlError = validateHealthCheckUrl(config.healthCheckUrl);
  if (urlError) {
    return err(
      new Error(
        `Health check URL rejected (${urlError}): ${config.healthCheckUrl}`,
      ),
    );
  }

  // DNS rebinding defense: resolve hostname and validate IP
  const ipError = await validateHealthCheckResolvedIP(config.healthCheckUrl);
  if (ipError) {
    return err(
      new Error(
        `Health check URL rejected (${ipError}): ${config.healthCheckUrl}`,
      ),
    );
  }

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const deployResult = await runCommand('sh', ['-c', config.deployCommand], {
      cwd: config.cwd,
      timeoutMs: config.deployTimeoutMs,
    });

    if (!deployResult.ok) {
      if (attempt === config.maxAttempts) {
        return ok({ status: 'failed', attempts: attempt });
      }
      continue;
    }

    // Poll health check
    const healthy = await pollHealth(
      config.healthCheckUrl,
      config.healthCheckIntervalMs,
      config.deployTimeoutMs,
    );

    if (healthy) {
      return ok({ status: 'healthy', attempts: attempt });
    }

    if (attempt === config.maxAttempts) {
      return ok({ status: 'timeout', attempts: attempt });
    }
    // Retry: re-deploy
  }

  return ok({ status: 'failed', attempts: config.maxAttempts });
}

// Note: TOCTOU gap exists between the upfront DNS validation in runDeploy()
// and the fetch calls below. A DNS rebinding attacker could flip the record
// after validation. This is the same tradeoff as notify.ts (see lines 157-160),
// but with a wider window since pollHealth loops. Accepted because healthCheckUrl
// is operator-level config, not end-user input.
async function pollHealth(
  url: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(intervalMs, deadline - Date.now())),
      });
      if (response.ok) return true;
    } catch {
      // Connection refused, timeout, etc. — keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
  }
  return false;
}
