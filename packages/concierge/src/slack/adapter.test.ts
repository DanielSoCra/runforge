import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeSlackEvent, parseConfirmationActionId, verifySlackSignature } from './adapter.js';

function sign(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return `v0=${digest}`;
}

describe('slack adapter', () => {
  it('verifies Slack request signatures and rejects stale timestamps', () => {
    const secret = 'signing-secret';
    const timestamp = 10_000;
    const body = JSON.stringify({ event: { type: 'message' } });

    expect(verifySlackSignature({
      signingSecret: secret,
      timestamp,
      rawBody: body,
      signature: sign(secret, timestamp, body),
      now: () => timestamp + 100,
    })).toBe(true);

    expect(verifySlackSignature({
      signingSecret: secret,
      timestamp,
      rawBody: body,
      signature: sign(secret, timestamp, body),
      now: () => timestamp + 301_000,
    })).toBe(false);
  });

  it('normalizes message events into conversation turns', () => {
    const event = normalizeSlackEvent({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'D123',
        user: 'U123',
        text: 'daemon status',
        ts: '111.222',
        thread_ts: '111.000',
      },
    });

    expect(event).toEqual({
      type: 'message',
      conversationId: 'D123:111.000',
      threadTs: '111.000',
      user: 'U123',
      text: 'daemon status',
    });
  });

  it('parses confirmation action ids from Slack block actions', () => {
    expect(parseConfirmationActionId('confirm:abc123:approve')).toEqual({
      confirmationId: 'abc123',
      decision: 'approve',
    });
    expect(parseConfirmationActionId('other')).toBeUndefined();
  });
});
