import { describe, expect, it } from 'vitest';
import type { ConfirmationRecord } from './state-machine.js';
import { renderConfirmationMessage } from './message.js';

describe('confirmation message rendering', () => {
  it('renders Block Kit controls with stable confirmation action ids', () => {
    const record: ConfirmationRecord = {
      id: 'conf-1',
      toolCallId: 'tool-1',
      conversationId: 'conv-1',
      toolName: 'mail_send',
      args: { draftId: 'draft-1' },
      blastReason: 'external email',
      status: 'pending',
      createdAt: 1_000,
      expiresAt: 2_000,
    };

    const message = renderConfirmationMessage(record);

    expect(message.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'Confirm: mail_send' },
    });
    expect(JSON.stringify(message)).toContain('external email');
    expect(JSON.stringify(message)).toContain('confirm:conf-1:approve');
    expect(JSON.stringify(message)).toContain('confirm:conf-1:deny');
  });
});
