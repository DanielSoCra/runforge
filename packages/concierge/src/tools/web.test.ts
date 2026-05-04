import { describe, expect, it } from 'vitest';
import { createWebToolHandlers } from './web.js';

describe('web tool handlers', () => {
  it('fetches text content and clips oversized responses', async () => {
    const handlers = createWebToolHandlers({
      maxBytes: 10,
      fetch: async () => new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    });

    await expect(handlers.web_fetch({ url: 'https://example.com' }, { conversationId: 'c1', toolCallId: 't1' }))
      .resolves.toEqual({
        url: 'https://example.com',
        status: 200,
        contentType: 'text/plain',
        text: 'hello worl',
        truncated: true,
      });
  });
});
