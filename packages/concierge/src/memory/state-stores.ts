import { randomUUID } from 'node:crypto';
import type {
  ConfirmationCreateInput,
  ConfirmationRecord,
  ConfirmationStatus,
  ConfirmationStore,
} from '../confirmation/state-machine.js';
import type { AuditLog, ToolCallAuditRecord, ToolCallAuditStatus } from '../core/audit-log.js';
import type {
  Conversation,
  ConversationRole,
  ConversationStore,
  ConversationStatus,
  ConversationTurn,
} from '../core/conversation.js';
import type { ConciergeStateDatabase, SqlParameter } from './node-sqlite.js';

export interface ConciergeStateStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export interface ConciergeEventRecord {
  id: number;
  source: string;
  type: string;
  payload: unknown;
  status: string;
  createdAt: number;
}

export interface ConciergeEventStore {
  append(input: Omit<ConciergeEventRecord, 'id' | 'createdAt'>): ConciergeEventRecord;
  list(): ConciergeEventRecord[];
}

export interface ConciergeCardRecord {
  id: string;
  status: string;
  title: string;
  body: string;
  confirmationId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConciergeCardStore {
  upsert(input: Omit<ConciergeCardRecord, 'createdAt' | 'updatedAt'>): ConciergeCardRecord;
  updateStatus(id: string, status: string): ConciergeCardRecord;
  get(id: string): ConciergeCardRecord | undefined;
  list(): ConciergeCardRecord[];
}

export interface ConciergeStateStores {
  conversations: ConversationStore;
  auditLog: AuditLog;
  confirmations: ConfirmationStore;
  events: ConciergeEventStore;
  cards: ConciergeCardStore;
}

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;

export function createConciergeStateStores(
  db: ConciergeStateDatabase,
  options: ConciergeStateStoreOptions = {},
): ConciergeStateStores {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;

  return {
    conversations: createSqlConversationStore(db, { now, createId }),
    auditLog: createSqlAuditLog(db, { now, createId }),
    confirmations: createSqlConfirmationStore(db, { now, createId }),
    events: createSqlEventStore(db, { now }),
    cards: createSqlCardStore(db, { now, createId }),
  };
}

function createSqlConversationStore(
  db: ConciergeStateDatabase,
  options: Required<ConciergeStateStoreOptions>,
): ConversationStore {
  const createTurn = (conversationId: string, role: ConversationRole, text: string, createdAt: number): ConversationTurn => {
    const turn: ConversationTurn = {
      id: options.createId(),
      role,
      text,
      createdAt,
    };
    db.run(
      'INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)',
      turn.id,
      conversationId,
      role,
      text,
      createdAt,
    );
    return turn;
  };

  return {
    startConversation(operatorText): Conversation {
      const timestamp = options.now();
      const id = options.createId();
      db.run(
        'INSERT INTO conversations (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)',
        id,
        'open',
        timestamp,
        timestamp,
      );
      createTurn(id, 'operator', operatorText, timestamp);
      return mustGetConversation(db, id);
    },

    appendTurn(conversationId, role, text): Conversation {
      const conversation = mustGetConversation(db, conversationId);
      if (conversation.status !== 'open') throw new Error(`conversation ${conversationId} is closed`);
      const timestamp = options.now();
      createTurn(conversationId, role, text, timestamp);
      db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', timestamp, conversationId);
      return mustGetConversation(db, conversationId);
    },

    resetConversation(conversationId): Conversation {
      mustGetConversation(db, conversationId);
      db.run('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?', 'closed', options.now(), conversationId);
      return mustGetConversation(db, conversationId);
    },

    getConversation(conversationId): Conversation | undefined {
      return getConversation(db, conversationId);
    },

    listConversations(): Conversation[] {
      const rows = db.all<ConversationRow>('SELECT id FROM conversations ORDER BY created_at, id');
      return rows.map((row) => mustGetConversation(db, row.id));
    },
  };
}

function createSqlAuditLog(
  db: ConciergeStateDatabase,
  options: Required<ConciergeStateStoreOptions>,
): AuditLog {
  return {
    record(input): ToolCallAuditRecord {
      const timestamp = options.now();
      const id = options.createId();
      db.run(
        `INSERT INTO tool_calls
          (id, conversation_id, tool_name, args, status, latency_ms, cost, confirmation_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.conversationId,
        input.toolName,
        stringifyJson(input.args),
        input.status,
        nullable(input.latencyMs),
        nullable(input.cost),
        nullable(input.confirmationId),
        nullable(input.error),
        timestamp,
        timestamp,
      );
      return mustGetAuditRecord(db, id);
    },

    update(id, patch): ToolCallAuditRecord {
      mustGetAuditRecord(db, id);
      const updates: string[] = [];
      const values: SqlParameter[] = [];
      if (patch.conversationId !== undefined) pushUpdate(updates, values, 'conversation_id', patch.conversationId);
      if (patch.toolName !== undefined) pushUpdate(updates, values, 'tool_name', patch.toolName);
      if (hasOwn(patch, 'args')) pushUpdate(updates, values, 'args', stringifyJson(patch.args));
      if (patch.status !== undefined) pushUpdate(updates, values, 'status', patch.status);
      if (hasOwn(patch, 'latencyMs')) pushUpdate(updates, values, 'latency_ms', nullable(patch.latencyMs));
      if (hasOwn(patch, 'cost')) pushUpdate(updates, values, 'cost', nullable(patch.cost));
      if (hasOwn(patch, 'confirmationId')) pushUpdate(updates, values, 'confirmation_id', nullable(patch.confirmationId));
      if (hasOwn(patch, 'error')) pushUpdate(updates, values, 'error', nullable(patch.error));
      pushUpdate(updates, values, 'updated_at', options.now());
      db.run(`UPDATE tool_calls SET ${updates.join(', ')} WHERE id = ?`, ...values, id);
      return mustGetAuditRecord(db, id);
    },

    get(id): ToolCallAuditRecord | undefined {
      return getAuditRecord(db, id);
    },

    list(): ToolCallAuditRecord[] {
      return db
        .all<ToolCallRow>('SELECT * FROM tool_calls ORDER BY created_at, id')
        .map(mapAuditRecord);
    },
  };
}

function createSqlConfirmationStore(
  db: ConciergeStateDatabase,
  options: Required<ConciergeStateStoreOptions>,
): ConfirmationStore {
  const respond = (id: string, status: Exclude<ConfirmationStatus, 'pending'>): ConfirmationRecord => {
    const current = mustGetConfirmation(db, id);
    if (current.status !== 'pending') return current;
    db.run(
      'UPDATE confirmations SET status = ?, responded_at = ? WHERE id = ?',
      status,
      options.now(),
      id,
    );
    return mustGetConfirmation(db, id);
  };

  return {
    create(input: ConfirmationCreateInput): ConfirmationRecord {
      const createdAt = options.now();
      const id = options.createId();
      db.run(
        `INSERT INTO confirmations
          (id, tool_call_id, conversation_id, tool_name, args, blast_reason, status, slack_message_ts, created_at, responded_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.toolCallId,
        input.conversationId,
        input.toolName,
        stringifyJson(input.args),
        input.blastReason,
        'pending',
        null,
        createdAt,
        null,
        createdAt + CONFIRMATION_TTL_MS,
      );
      return mustGetConfirmation(db, id);
    },

    get(id): ConfirmationRecord | undefined {
      return getConfirmation(db, id);
    },

    list(): ConfirmationRecord[] {
      return db
        .all<ConfirmationRow>('SELECT * FROM confirmations ORDER BY created_at, id')
        .map(mapConfirmation);
    },

    approve(id): ConfirmationRecord {
      return respond(id, 'approved');
    },

    deny(id): ConfirmationRecord {
      return respond(id, 'denied');
    },

    expirePending(): ConfirmationRecord[] {
      const currentTime = options.now();
      const expired = db.all<ConfirmationRow>(
        'SELECT * FROM confirmations WHERE status = ? AND expires_at < ? ORDER BY expires_at, id',
        'pending',
        currentTime,
      );
      for (const row of expired) {
        db.run('UPDATE confirmations SET status = ?, responded_at = ? WHERE id = ?', 'expired', currentTime, row.id);
      }
      return expired.map((row) => mustGetConfirmation(db, row.id));
    },
  };
}

function createSqlEventStore(
  db: ConciergeStateDatabase,
  options: Pick<Required<ConciergeStateStoreOptions>, 'now'>,
): ConciergeEventStore {
  return {
    append(input): ConciergeEventRecord {
      db.run(
        'INSERT INTO events (source, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)',
        input.source,
        input.type,
        stringifyJson(input.payload),
        input.status,
        options.now(),
      );
      const row = db.get<EventRow>('SELECT * FROM events WHERE id = last_insert_rowid()');
      if (!row) throw new Error('event insert failed');
      return mapEvent(row);
    },

    list(): ConciergeEventRecord[] {
      return db.all<EventRow>('SELECT * FROM events ORDER BY created_at, id').map(mapEvent);
    },
  };
}

function createSqlCardStore(
  db: ConciergeStateDatabase,
  options: Required<ConciergeStateStoreOptions>,
): ConciergeCardStore {
  return {
    upsert(input): ConciergeCardRecord {
      const timestamp = options.now();
      const id = input.id || options.createId();
      db.run(
        `INSERT INTO cards (id, status, title, body, confirmation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           title = excluded.title,
           body = excluded.body,
           confirmation_id = excluded.confirmation_id,
           updated_at = excluded.updated_at`,
        id,
        input.status,
        input.title,
        input.body,
        nullable(input.confirmationId),
        timestamp,
        timestamp,
      );
      return mustGetCard(db, id);
    },

    updateStatus(id, status): ConciergeCardRecord {
      mustGetCard(db, id);
      db.run('UPDATE cards SET status = ?, updated_at = ? WHERE id = ?', status, options.now(), id);
      return mustGetCard(db, id);
    },

    get(id): ConciergeCardRecord | undefined {
      return getCard(db, id);
    },

    list(): ConciergeCardRecord[] {
      return db.all<CardRow>('SELECT * FROM cards ORDER BY updated_at, id').map(mapCard);
    },
  };
}

interface ConversationRow {
  id: string;
  status: ConversationStatus;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  role: ConversationRole;
  text: string;
  created_at: number;
}

interface ToolCallRow {
  id: string;
  conversation_id: string;
  tool_name: string;
  args: string;
  status: ToolCallAuditStatus;
  latency_ms: number | null;
  cost: number | null;
  confirmation_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface ConfirmationRow {
  id: string;
  tool_call_id: string;
  conversation_id: string;
  tool_name: string;
  args: string;
  blast_reason: string;
  status: ConfirmationStatus;
  slack_message_ts: string | null;
  created_at: number;
  responded_at: number | null;
  expires_at: number;
}

interface EventRow {
  id: number;
  source: string;
  type: string;
  payload: string;
  status: string;
  created_at: number;
}

interface CardRow {
  id: string;
  status: string;
  title: string;
  body: string;
  confirmation_id: string | null;
  created_at: number;
  updated_at: number;
}

function getConversation(db: ConciergeStateDatabase, id: string): Conversation | undefined {
  const row = db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
  if (!row) return undefined;
  const turns = db
    .all<MessageRow>('SELECT id, role, text, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id', id)
    .map((turn): ConversationTurn => ({
      id: turn.id,
      role: turn.role,
      text: turn.text,
      createdAt: turn.created_at,
    }));
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turns,
  };
}

function mustGetConversation(db: ConciergeStateDatabase, id: string): Conversation {
  const conversation = getConversation(db, id);
  if (!conversation) throw new Error(`conversation ${id} not found`);
  return conversation;
}

function getAuditRecord(db: ConciergeStateDatabase, id: string): ToolCallAuditRecord | undefined {
  const row = db.get<ToolCallRow>('SELECT * FROM tool_calls WHERE id = ?', id);
  return row ? mapAuditRecord(row) : undefined;
}

function mustGetAuditRecord(db: ConciergeStateDatabase, id: string): ToolCallAuditRecord {
  const record = getAuditRecord(db, id);
  if (!record) throw new Error(`tool call ${id} not found`);
  return record;
}

function mapAuditRecord(row: ToolCallRow): ToolCallAuditRecord {
  return omitUndefined({
    id: row.id,
    conversationId: row.conversation_id,
    toolName: row.tool_name,
    args: parseJson(row.args),
    status: row.status,
    latencyMs: row.latency_ms ?? undefined,
    cost: row.cost ?? undefined,
    confirmationId: row.confirmation_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function getConfirmation(db: ConciergeStateDatabase, id: string): ConfirmationRecord | undefined {
  const row = db.get<ConfirmationRow>('SELECT * FROM confirmations WHERE id = ?', id);
  return row ? mapConfirmation(row) : undefined;
}

function mustGetConfirmation(db: ConciergeStateDatabase, id: string): ConfirmationRecord {
  const confirmation = getConfirmation(db, id);
  if (!confirmation) throw new Error(`confirmation ${id} not found`);
  return confirmation;
}

function mapConfirmation(row: ConfirmationRow): ConfirmationRecord {
  return omitUndefined({
    id: row.id,
    toolCallId: row.tool_call_id,
    conversationId: row.conversation_id,
    toolName: row.tool_name,
    args: parseJson(row.args),
    blastReason: row.blast_reason,
    status: row.status,
    slackMessageTs: row.slack_message_ts ?? undefined,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
    expiresAt: row.expires_at,
  });
}

function mapEvent(row: EventRow): ConciergeEventRecord {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    payload: parseJson(row.payload),
    status: row.status,
    createdAt: row.created_at,
  };
}

function getCard(db: ConciergeStateDatabase, id: string): ConciergeCardRecord | undefined {
  const row = db.get<CardRow>('SELECT * FROM cards WHERE id = ?', id);
  return row ? mapCard(row) : undefined;
}

function mustGetCard(db: ConciergeStateDatabase, id: string): ConciergeCardRecord {
  const card = getCard(db, id);
  if (!card) throw new Error(`card ${id} not found`);
  return card;
}

function mapCard(row: CardRow): ConciergeCardRecord {
  return omitUndefined({
    id: row.id,
    status: row.status,
    title: row.title,
    body: row.body,
    confirmationId: row.confirmation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function nullable(value: string | number | undefined): string | number | null {
  return value ?? null;
}

function pushUpdate(
  updates: string[],
  values: SqlParameter[],
  column: string,
  value: SqlParameter,
): void {
  updates.push(`${column} = ?`);
  values.push(value);
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
