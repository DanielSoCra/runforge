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

export async function notify(
  webhookUrls: string[],
  payload: NotificationPayload,
): Promise<NotificationResult> {
  const failedUrls: string[] = [];

  for (const url of webhookUrls) {
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
