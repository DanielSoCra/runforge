import { describe, expect, it } from 'vitest';
import { createConfirmationStore } from './state-machine.js';

describe('confirmation lifecycle', () => {
  it('moves a high-blast action through pending to approved exactly once', () => {
    const store = createConfirmationStore({ now: () => 1_000 });
    const confirmation = store.create({
      toolCallId: 'tool-1',
      conversationId: 'conv-1',
      toolName: 'mail_send',
      args: { to: 'person@example.com' },
      blastReason: 'external email',
    });

    expect(confirmation.status).toBe('pending');
    expect(confirmation.expiresAt).toBe(1_000 + 24 * 60 * 60 * 1_000);

    const approved = store.approve(confirmation.id);
    const duplicate = store.deny(confirmation.id);

    expect(approved.status).toBe('approved');
    expect(duplicate.status).toBe('approved');
  });

  it('expires only pending confirmations whose deadline passed', () => {
    let now = 1_000;
    const store = createConfirmationStore({ now: () => now });
    const pending = store.create({
      toolCallId: 'tool-1',
      conversationId: 'conv-1',
      toolName: 'mail_send',
      args: {},
      blastReason: 'external email',
    });
    const denied = store.deny(store.create({
      toolCallId: 'tool-2',
      conversationId: 'conv-1',
      toolName: 'slack_send_channel',
      args: {},
      blastReason: 'external Slack post',
    }).id);

    now = pending.expiresAt + 1;
    const expired = store.expirePending();

    expect(expired.map((item) => item.id)).toEqual([pending.id]);
    expect(store.get(pending.id)?.status).toBe('expired');
    expect(store.get(denied.id)?.status).toBe('denied');
  });
});
