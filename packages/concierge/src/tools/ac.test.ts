import { describe, expect, it } from 'vitest';
import { createRunforgeToolHandlers } from './ac.js';

describe('runforge tool handlers', () => {
  it('reads daemon status through the control-plane HTTP API', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const handlers = createRunforgeToolHandlers({
      baseUrl: 'http://127.0.0.1:3847',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ paused: true }), { status: 200 });
      },
    });

    await expect(handlers.ac_status({}, { conversationId: 'c1', toolCallId: 't1' })).resolves.toEqual({
      paused: true,
    });
    expect(requests).toEqual([{ url: 'http://127.0.0.1:3847/status', init: { method: 'GET' } }]);
  });

  it('sends X-Requested-By on mutating daemon calls', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const handlers = createRunforgeToolHandlers({
      baseUrl: 'http://daemon',
      requestedBy: 'concierge-test',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ retrying: 504 }), { status: 200 });
      },
    });

    await handlers.ac_unstuck({ issue: 504 }, { conversationId: 'c1', toolCallId: 't1' });

    expect(requests[0]).toEqual({
      url: 'http://daemon/retry/504',
      init: {
        method: 'POST',
        headers: { 'X-Requested-By': 'concierge-test' },
      },
    });
  });

  it('throws readable errors for non-2xx daemon responses', async () => {
    const handlers = createRunforgeToolHandlers({
      baseUrl: 'http://daemon',
      fetch: async () => new Response(JSON.stringify({ error: 'missing issue' }), { status: 404 }),
    });

    await expect(handlers.ac_run({ issue: 999 }, { conversationId: 'c1', toolCallId: 't1' }))
      .rejects.toThrow(/runforge request failed 404: missing issue/);
  });
});
