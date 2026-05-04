import { randomUUID } from 'node:crypto';

export type ToolCallAuditStatus =
  | 'allowed'
  | 'pending_confirmation'
  | 'confirmed'
  | 'denied'
  | 'expired'
  | 'errored';

export interface ToolCallAuditRecord {
  id: string;
  conversationId: string;
  toolName: string;
  args: unknown;
  status: ToolCallAuditStatus;
  latencyMs?: number;
  cost?: number;
  confirmationId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AuditLog {
  record(input: Omit<ToolCallAuditRecord, 'id' | 'createdAt' | 'updatedAt'>): ToolCallAuditRecord;
  update(id: string, patch: Partial<Omit<ToolCallAuditRecord, 'id' | 'createdAt'>>): ToolCallAuditRecord;
  get(id: string): ToolCallAuditRecord | undefined;
  list(): ToolCallAuditRecord[];
}

export interface AuditLogOptions {
  now?: () => number;
  createId?: () => string;
}

export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const records = new Map<string, ToolCallAuditRecord>();

  return {
    record(input): ToolCallAuditRecord {
      const timestamp = now();
      const record: ToolCallAuditRecord = {
        id: createId(),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...input,
      };
      records.set(record.id, record);
      return record;
    },

    update(id, patch): ToolCallAuditRecord {
      const record = records.get(id);
      if (!record) throw new Error(`tool call ${id} not found`);
      const updated: ToolCallAuditRecord = {
        ...record,
        ...patch,
        updatedAt: now(),
      };
      records.set(id, updated);
      return updated;
    },

    get(id): ToolCallAuditRecord | undefined {
      return records.get(id);
    },

    list(): ToolCallAuditRecord[] {
      return [...records.values()];
    },
  };
}
