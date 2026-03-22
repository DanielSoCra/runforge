// src/control-plane/notify.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notify, validateWebhookUrl, type NotificationPayload } from './notify.js';

const makePayload = (overrides?: Partial<NotificationPayload>): NotificationPayload => ({
  event: 'phase.complete',
  issueNumber: 42,
  phase: 'implement',
  message: 'Implementation completed',
  ...overrides,
});

describe('notify', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Run notify and advance fake timers so retry delays resolve. */
  async function notifyWithTimers(
    urls: string[],
    payload: NotificationPayload,
  ) {
    const promise = notify(urls, payload);
    // Advance past retry delays (5s per URL that fails)
    for (let i = 0; i < urls.length; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    return promise;
  }

  it('sends a POST request to each webhook URL', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const payload = makePayload();
    await notify(['https://hooks.example.com/abc', 'https://hooks.example.com/xyz'], payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/abc',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/xyz',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends correct JSON payload body', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const payload: NotificationPayload = {
      event: 'run.complete',
      issueNumber: 99,
      phase: 'report',
      message: 'Run finished',
    };
    await notify(['https://hooks.example.com/test'], payload);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const options = call![1];
    expect(JSON.parse(options.body as string)).toEqual(payload);
  });

  it('continues processing remaining URLs after one fails (after retry)', async () => {
    // First URL fails on both attempts; second URL succeeds
    fetchMock
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await notifyWithTimers(
      ['https://hooks.example.com/fail', 'https://hooks.example.com/ok'],
      makePayload(),
    );

    // Should have called the second URL despite first failing
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.example.com/ok', expect.anything());
    warnSpy.mockRestore();
  });

  it('retries once on HTTP error status', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true });

    await notifyWithTimers(['https://hooks.example.com/test'], makePayload());

    // Should have been called twice (initial + retry)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs a warning when both attempts fail', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('still failing'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await notifyWithTimers(['https://hooks.example.com/fail'], makePayload());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://hooks.example.com/fail'),
    );
    warnSpy.mockRestore();
  });

  it('waits 5 seconds before retrying per STACK-AC-CONTROL-PLANE spec (#94)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    fetchMock.mockResolvedValueOnce({ ok: true });

    const promise = notify(['https://hooks.example.com/test'], makePayload());

    // The retry should not have fired yet (only 1s elapsed)
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance to 5s — retry should fire
    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing when webhookUrls is empty', async () => {
    await notify([], makePayload());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('works with payload that has no phase field', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const payload: NotificationPayload = {
      event: 'run.started',
      issueNumber: 1,
      message: 'Starting run',
    };
    await notify(['https://hooks.example.com/test'], payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call![1].body as string);
    expect(body.phase).toBeUndefined();
  });

  it('does not throw even when all webhooks fail', async () => {
    fetchMock.mockRejectedValue(new Error('total failure'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      notifyWithTimers(['https://hooks.example.com/a', 'https://hooks.example.com/b'], makePayload()),
    ).resolves.toBeDefined();

    warnSpy.mockRestore();
  });

  it('returns failedUrls so callers can detect notification failures', async () => {
    fetchMock.mockRejectedValue(new Error('total failure'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await notifyWithTimers(
      ['https://hooks.example.com/a', 'https://hooks.example.com/b'],
      makePayload(),
    );

    expect(result.failedUrls).toEqual([
      'https://hooks.example.com/a',
      'https://hooks.example.com/b',
    ]);
    warnSpy.mockRestore();
  });

  it('returns empty failedUrls when all webhooks succeed', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const result = await notify(
      ['https://hooks.example.com/a', 'https://hooks.example.com/b'],
      makePayload(),
    );

    expect(result.failedUrls).toEqual([]);
  });

  it('reports failure when retry returns HTTP error status', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 502 })   // initial fails
      .mockResolvedValueOnce({ ok: false, status: 503 });   // retry also fails
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await notifyWithTimers(
      ['https://hooks.example.com/flaky'],
      makePayload(),
    );

    expect(result.failedUrls).toEqual(['https://hooks.example.com/flaky']);
    warnSpy.mockRestore();
  });

  it('returns only the URLs that failed, not those that succeeded', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true })                  // URL a succeeds
      .mockRejectedValueOnce(new Error('network error'))     // URL b fails
      .mockRejectedValueOnce(new Error('retry also fails')); // URL b retry fails
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await notifyWithTimers(
      ['https://hooks.example.com/a', 'https://hooks.example.com/b'],
      makePayload(),
    );

    expect(result.failedUrls).toEqual(['https://hooks.example.com/b']);
    warnSpy.mockRestore();
  });
});

describe('validateWebhookUrl', () => {
  it('accepts https URLs with public hostnames', () => {
    expect(validateWebhookUrl('https://hooks.example.com/abc')).toBeNull();
    expect(validateWebhookUrl('https://api.slack.com/webhook')).toBeNull();
  });

  it('rejects http URLs', () => {
    expect(validateWebhookUrl('http://hooks.example.com/abc')).toContain('not allowed');
  });

  it('rejects non-http schemes', () => {
    expect(validateWebhookUrl('ftp://example.com/file')).toContain('not allowed');
    expect(validateWebhookUrl('file:///etc/passwd')).toContain('not allowed');
  });

  it('rejects localhost', () => {
    expect(validateWebhookUrl('https://localhost/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://LOCALHOST/hook')).toContain('blocked');
  });

  it('rejects loopback IP 127.x.x.x', () => {
    expect(validateWebhookUrl('https://127.0.0.1/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://127.0.0.2:8080/hook')).toContain('blocked');
  });

  it('rejects cloud metadata endpoint 169.254.x.x', () => {
    expect(validateWebhookUrl('https://169.254.169.254/latest/meta-data')).toContain('blocked');
  });

  it('rejects RFC 1918 private ranges', () => {
    expect(validateWebhookUrl('https://10.0.0.1/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://172.16.0.1/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://172.31.255.255/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://192.168.1.1/hook')).toContain('blocked');
  });

  it('allows 172.x.x.x outside the 16-31 range', () => {
    expect(validateWebhookUrl('https://172.15.0.1/hook')).toBeNull();
    expect(validateWebhookUrl('https://172.32.0.1/hook')).toBeNull();
  });

  it('rejects IPv6 loopback', () => {
    expect(validateWebhookUrl('https://[::1]/hook')).toContain('blocked');
  });

  it('rejects 0.0.0.0', () => {
    expect(validateWebhookUrl('https://0.0.0.0/hook')).toContain('blocked');
  });

  it('rejects IPv6-mapped IPv4 private addresses', () => {
    // URL constructor normalizes these to hex form (e.g. [::ffff:7f00:1])
    expect(validateWebhookUrl('https://[::ffff:127.0.0.1]/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://[::ffff:10.0.0.1]/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://[::ffff:172.16.0.1]/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://[::ffff:192.168.1.1]/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://[::ffff:169.254.169.254]/hook')).toContain('blocked');
    expect(validateWebhookUrl('https://[::ffff:0.0.0.0]/hook')).toContain('blocked');
  });

  it('rejects invalid URLs', () => {
    expect(validateWebhookUrl('not-a-url')).toContain('invalid');
  });
});

describe('notify SSRF protection (#29)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects internal URLs without making fetch calls', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await notify(
      ['http://169.254.169.254/latest/meta-data', 'https://localhost/hook'],
      makePayload(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failedUrls).toEqual([
      'http://169.254.169.254/latest/meta-data',
      'https://localhost/hook',
    ]);
    warnSpy.mockRestore();
  });

  it('processes valid URLs normally while rejecting invalid ones', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await notify(
      ['https://hooks.example.com/ok', 'https://10.0.0.1/internal'],
      makePayload(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.example.com/ok', expect.anything());
    expect(result.failedUrls).toEqual(['https://10.0.0.1/internal']);
    warnSpy.mockRestore();
  });
});
