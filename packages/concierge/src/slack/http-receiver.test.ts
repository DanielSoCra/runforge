import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSlackHttpReceiver, handleSlackHttpRequest } from './http-receiver.js';
import type { SlackRuntimeHandlers } from '../core/runtime.js';

const signingSecret = 'signing-secret';
const timestamp = 10_000;

describe('Slack HTTP receiver', () => {
  it('starts and stops a local receiver without leaking the server handle', async () => {
    const receiver = createSlackHttpReceiver({
      signingSecret,
      port: 0,
    });

    await receiver.start(handlers([]));
    await receiver.stop();
    await receiver.stop();
  });

  it('rejects requests with an invalid Slack signature', async () => {
    const calls: unknown[] = [];
    const response = await handleSlackHttpRequest({
      request: signedRequest(JSON.stringify({ type: 'event_callback' }), 'bad-signature'),
      handlers: handlers(calls),
      signingSecret,
      now: () => timestamp,
    });

    expect(response).toEqual({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'invalid slack signature' }),
    });
    expect(calls).toEqual([]);
  });

  it('responds to Slack URL verification challenges without dispatching a handler', async () => {
    const calls: unknown[] = [];
    const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-token' });
    const response = await handleSlackHttpRequest({
      request: signedRequest(body),
      handlers: handlers(calls),
      signingSecret,
      now: () => timestamp,
    });

    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'challenge-token',
    });
    expect(calls).toEqual([]);
  });

  it('normalizes Slack message events and dispatches them to the runtime handler', async () => {
    const calls: unknown[] = [];
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'D123',
        user: 'U123',
        text: 'status?',
        ts: '111.222',
      },
    });
    const response = await handleSlackHttpRequest({
      request: signedRequest(body),
      handlers: handlers(calls),
      signingSecret,
      now: () => timestamp,
    });

    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    expect(calls).toEqual([{
      kind: 'message',
      message: {
        type: 'message',
        conversationId: 'D123:111.222',
        threadTs: '111.222',
        user: 'U123',
        text: 'status?',
      },
    }]);
  });

  it('routes Slack block action confirmations to the runtime handler', async () => {
    const calls: unknown[] = [];
    const payload = {
      type: 'block_actions',
      actions: [{ action_id: 'confirm:conf-1:approve' }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const response = await handleSlackHttpRequest({
      request: signedRequest(body, undefined, 'application/x-www-form-urlencoded'),
      handlers: handlers(calls),
      signingSecret,
      now: () => timestamp,
    });

    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    expect(calls).toEqual([{
      kind: 'confirmation',
      action: { confirmationId: 'conf-1', decision: 'approve' },
    }]);
  });

  it('routes local board card actions without requiring a Slack signature', async () => {
    const calls: unknown[] = [];
    const response = await handleSlackHttpRequest({
      request: {
        method: 'POST',
        path: '/board/cards/card-1/done',
        headers: {},
        body: '',
      },
      handlers: handlers(calls),
      signingSecret,
      now: () => timestamp,
    });

    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        card: {
          id: 'card-1',
          status: 'done',
          title: 'Done',
          body: 'Done',
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      }),
    });
    expect(calls).toEqual([{
      kind: 'boardCardAction',
      action: { cardId: 'card-1', action: 'done' },
    }]);
  });
});

function signedRequest(
  body: string,
  signature = sign(signingSecret, timestamp, body),
  contentType = 'application/json',
) {
  return {
    method: 'POST',
    path: '/slack/events',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
    },
    body,
  };
}

function handlers(calls: unknown[]): SlackRuntimeHandlers {
  return {
    message: async (message) => {
      calls.push({ kind: 'message', message });
    },
    confirmation: async (action) => {
      calls.push({ kind: 'confirmation', action });
    },
    boardCardAction: async (action) => {
      calls.push({ kind: 'boardCardAction', action });
      return {
        status: 'completed',
        card: {
          id: action.cardId,
          status: action.action,
          title: 'Done',
          body: 'Done',
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      };
    },
  };
}

function sign(secret: string, signedTimestamp: number, body: string): string {
  const digest = createHmac('sha256', secret)
    .update(`v0:${signedTimestamp}:${body}`)
    .digest('hex');
  return `v0=${digest}`;
}
