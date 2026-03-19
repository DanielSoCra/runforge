// src/control-plane/notify.ts
export interface NotificationPayload {
  event: string;
  issueNumber: number;
  phase?: string;
  message: string;
}

export async function notify(
  webhookUrls: string[],
  payload: NotificationPayload,
): Promise<void> {
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
      // Retry once after 1 second
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Log warning but don't block pipeline
        console.warn(`Webhook notification failed for ${url}`);
      }
    }
  }
}
