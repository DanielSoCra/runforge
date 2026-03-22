// src/control-plane/notify.ts
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
