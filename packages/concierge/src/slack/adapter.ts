import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifySlackSignatureInput {
  signingSecret: string;
  timestamp: number;
  rawBody: string;
  signature: string;
  now?: () => number;
}

export interface NormalizedSlackMessage {
  type: 'message';
  conversationId: string;
  threadTs: string;
  user: string;
  text: string;
}

export interface ConfirmationAction {
  confirmationId: string;
  decision: 'approve' | 'deny';
}

const SLACK_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1_000;

export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const now = input.now ?? Date.now;
  if (Math.abs(now() - input.timestamp) > SLACK_SIGNATURE_TOLERANCE_MS) {
    return false;
  }

  const expected = `v0=${createHmac('sha256', input.signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest('hex')}`;

  return timingSafeStringEqual(expected, input.signature);
}

export function normalizeSlackEvent(payload: unknown): NormalizedSlackMessage | undefined {
  const event = readObject(readObject(payload).event);
  if (event.type !== 'message') return undefined;
  const channel = readString(event.channel);
  const user = readString(event.user);
  const text = readString(event.text);
  const ts = readString(event.ts);
  const threadTs = readString(event.thread_ts) || ts;
  if (!channel || !user || !threadTs) return undefined;

  return {
    type: 'message',
    conversationId: `${channel}:${threadTs}`,
    threadTs,
    user,
    text,
  };
}

export function parseConfirmationActionId(actionId: string): ConfirmationAction | undefined {
  const match = /^confirm:([^:]+):(approve|deny)$/.exec(actionId);
  if (!match) return undefined;
  return {
    confirmationId: match[1]!,
    decision: match[2] as 'approve' | 'deny',
  };
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
