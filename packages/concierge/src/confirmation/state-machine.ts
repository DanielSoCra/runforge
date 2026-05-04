import { randomUUID } from 'node:crypto';

export type ConfirmationStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'errored';

export interface ConfirmationRecord {
  id: string;
  toolCallId: string;
  conversationId: string;
  toolName: string;
  args: unknown;
  blastReason: string;
  status: ConfirmationStatus;
  slackMessageTs?: string;
  createdAt: number;
  respondedAt?: number;
  expiresAt: number;
}

export interface ConfirmationCreateInput {
  toolCallId: string;
  conversationId: string;
  toolName: string;
  args: unknown;
  blastReason: string;
}

export interface ConfirmationStore {
  create(input: ConfirmationCreateInput): ConfirmationRecord;
  get(id: string): ConfirmationRecord | undefined;
  list(): ConfirmationRecord[];
  approve(id: string): ConfirmationRecord;
  deny(id: string): ConfirmationRecord;
  expirePending(): ConfirmationRecord[];
}

export interface ConfirmationStoreOptions {
  now?: () => number;
  createId?: () => string;
}

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;

export function createConfirmationStore(options: ConfirmationStoreOptions = {}): ConfirmationStore {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const records = new Map<string, ConfirmationRecord>();

  const respond = (id: string, status: Exclude<ConfirmationStatus, 'pending'>): ConfirmationRecord => {
    const record = records.get(id);
    if (!record) throw new Error(`confirmation ${id} not found`);
    if (record.status !== 'pending') return record;
    const updated: ConfirmationRecord = {
      ...record,
      status,
      respondedAt: now(),
    };
    records.set(id, updated);
    return updated;
  };

  return {
    create(input: ConfirmationCreateInput): ConfirmationRecord {
      const createdAt = now();
      const record: ConfirmationRecord = {
        id: createId(),
        ...input,
        status: 'pending',
        createdAt,
        expiresAt: createdAt + CONFIRMATION_TTL_MS,
      };
      records.set(record.id, record);
      return record;
    },

    get(id: string): ConfirmationRecord | undefined {
      return records.get(id);
    },

    list(): ConfirmationRecord[] {
      return [...records.values()];
    },

    approve(id: string): ConfirmationRecord {
      return respond(id, 'approved');
    },

    deny(id: string): ConfirmationRecord {
      return respond(id, 'denied');
    },

    expirePending(): ConfirmationRecord[] {
      const expired: ConfirmationRecord[] = [];
      const currentTime = now();
      for (const record of records.values()) {
        if (record.status !== 'pending' || record.expiresAt >= currentTime) continue;
        const updated: ConfirmationRecord = {
          ...record,
          status: 'expired',
          respondedAt: currentTime,
        };
        records.set(record.id, updated);
        expired.push(updated);
      }
      return expired;
    },
  };
}
