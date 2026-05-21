import type { ConfirmationRecord } from './state-machine.js';

export type BlockKitText = {
  type: 'plain_text' | 'mrkdwn';
  text: string;
};

export type BlockKitBlock =
  | { type: 'header'; text: BlockKitText }
  | { type: 'section'; text: BlockKitText }
  | { type: 'actions'; elements: BlockKitButton[] }
  | { type: 'context'; elements: BlockKitText[] };

export interface BlockKitButton {
  type: 'button';
  text: BlockKitText;
  style?: 'primary' | 'danger';
  action_id: string;
}

export interface ConfirmationMessage {
  text: string;
  blocks: BlockKitBlock[];
}

export function renderConfirmationMessage(record: ConfirmationRecord): ConfirmationMessage {
  const args = JSON.stringify(record.args, null, 2);
  return {
    text: `Confirm: ${record.toolName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Confirm: ${record.toolName}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Arguments*\n\`\`\`${args}\`\`\`\n*Why this needs confirmation*\n${record.blastReason}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: `confirm:${record.id}:approve`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            style: 'danger',
            action_id: `confirm:${record.id}:deny`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Expires at ${new Date(record.expiresAt).toISOString()}`,
          },
        ],
      },
    ],
  };
}
