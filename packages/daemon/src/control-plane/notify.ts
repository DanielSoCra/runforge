// src/control-plane/notify.ts
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface NotificationPayload {
  event: string;
  issueNumber: number;
  phase?: string;
  message: string;
}

export interface NotificationResult {
  /** URLs where both initial attempt and retry failed. */
  failedUrls: string[];
}

/**
 * Private/internal IP patterns that must not be contacted via webhooks.
 * Covers: loopback, link-local, RFC 1918 private ranges, IPv6 loopback,
 * and IPv6-mapped IPv4 addresses.
 *
 * Note: These regexes assume the URL constructor has already normalized the
 * hostname. They are a pre-flight check on the hostname string and do not
 * protect against DNS rebinding (where a public hostname resolves to a
 * private IP at fetch time).
 */
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^\[::1\]$/,
  /^0\.0\.0\.0$/,
  // IPv6-mapped IPv4 (URL constructor normalizes to hex: [::ffff:7f00:1])
  /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i,       // 127.x.x.x
  /^\[::ffff:a[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i,         // 10.x.x.x
  /^\[::ffff:ac1[0-9a-f]:[0-9a-f]{1,4}\]$/i,          // 172.16-31.x.x
  /^\[::ffff:c0a8:[0-9a-f]{1,4}\]$/i,                  // 192.168.x.x
  /^\[::ffff:a9fe:[0-9a-f]{1,4}\]$/i,                  // 169.254.x.x
  /^\[::ffff:0{1,4}:0{1,4}\]$/i,                        // 0.0.0.0
];

/** Returns a rejection reason if the URL is not safe, or null if it's OK. */
export function validateWebhookUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalid URL';
  }
  if (parsed.protocol !== 'https:') {
    return `scheme '${parsed.protocol}' not allowed (only https)`;
  }
  const hostname = parsed.hostname;
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return `hostname '${hostname}' is a blocked internal address`;
    }
  }
  return null;
}

/**
 * Additional patterns for bare IP addresses returned by dns.lookup().
 * These cover IPv6 ranges not present in BLOCKED_HOSTNAME_PATTERNS
 * (which targets URL-formatted hostnames with bracket notation).
 */
const BLOCKED_RESOLVED_IP_PATTERNS = [
  /^fc[0-9a-f]{2}:/i,                     // IPv6 ULA fc00::/7
  /^fd[0-9a-f]{2}:/i,                     // IPv6 ULA fc00::/7
  /^fe[89ab][0-9a-f]:/i,                  // IPv6 link-local fe80::/10
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // CGNAT 100.64.0.0/10
];

/** Returns true if the given IP address falls within a private/internal range. */
export function isPrivateIP(ip: string): boolean {
  // Strip IPv6 bracket notation if present
  const bare = ip.replace(/^\[|\]$/g, '');

  // Handle IPv6-mapped IPv4 in dotted notation (e.g. ::ffff:127.0.0.1)
  const v4Mapped = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4Mapped) {
    return isPrivateIP(v4Mapped[1]);
  }

  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(bare) || pattern.test(`[${bare}]`)) {
      return true;
    }
  }
  for (const pattern of BLOCKED_RESOLVED_IP_PATTERNS) {
    if (pattern.test(bare)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the hostname of a webhook URL and validates that it does not point
 * to a private/internal IP address. Defends against DNS rebinding attacks.
 *
 * @returns null if safe, or a rejection string if the resolved IP is private.
 */
export async function validateResolvedIP(raw: string): Promise<string | null> {
  const parsed = new URL(raw);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // If the hostname is already an IP literal, skip DNS resolution
  if (isIP(hostname)) {
    return isPrivateIP(hostname)
      ? `resolved IP '${hostname}' is a blocked internal address`
      : null;
  }

  try {
    // Resolve all addresses (IPv4 + IPv6) to prevent dual-stack bypass
    // where an attacker hides a private AAAA behind a safe A record.
    const results = await lookup(hostname, { all: true });
    for (const { address } of results) {
      if (isPrivateIP(address)) {
        return `resolved IP '${address}' for hostname '${hostname}' is a blocked internal address (possible DNS rebinding)`;
      }
    }
    return null;
  } catch (err) {
    return `DNS resolution failed for '${hostname}': ${(err as Error).message}`;
  }
}

export async function notify(
  webhookUrls: string[],
  payload: NotificationPayload,
): Promise<NotificationResult> {
  const failedUrls: string[] = [];

  for (const url of webhookUrls) {
    const rejection = validateWebhookUrl(url);
    if (rejection) {
      console.warn(`Webhook URL rejected (${rejection}): ${url}`);
      failedUrls.push(url);
      continue;
    }

    // DNS rebinding defense: validate the resolved IP before each fetch.
    // Note: a small TOCTOU gap exists between this check and fetch's actual
    // connection. Fully closing it would require a custom DNS resolver pinning
    // the IP to the socket. The current approach raises the bar significantly —
    // an attacker would need sub-second TTL rebinding timed precisely in the gap.
    const ipRejection = await validateResolvedIP(url);
    if (ipRejection) {
      console.warn(`Webhook URL rejected (${ipRejection}): ${url}`);
      failedUrls.push(url);
      continue;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Retry once after 5 seconds (per STACK-AC-CONTROL-PLANE spec)
      await new Promise((r) => setTimeout(r, 5000));

      // Re-validate resolved IP before retry (DNS may have changed)
      const retryIpRejection = await validateResolvedIP(url);
      if (retryIpRejection) {
        console.warn(`Webhook URL rejected on retry (${retryIpRejection}): ${url}`);
        failedUrls.push(url);
        continue;
      }

      try {
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (!retryRes.ok) throw new Error(`HTTP ${retryRes.status}`);
      } catch {
        // Log warning but don't block pipeline
        console.warn(`Webhook notification failed for ${url}`);
        failedUrls.push(url);
      }
    }
  }

  return { failedUrls };
}
