import type { ConfirmationStore } from '../confirmation/state-machine.js';
import type { ToolEntry, ToolRegistry, JsonSchema } from '../tools/registry.js';
import type { AuditLog } from './audit-log.js';

export interface ToolDispatchRequest {
  conversationId: string;
  toolName: string;
  args: unknown;
}

export type ToolDispatchResult =
  | { status: 'completed'; result: unknown }
  | { status: 'pending_confirmation'; confirmationId: string; message: string }
  | { status: 'invalid_args'; errors: string[] }
  | { status: 'unavailable'; error: string }
  | { status: 'denied'; error: string }
  | { status: 'expired'; error: string }
  | { status: 'errored'; error: string };

export interface ToolRouter {
  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult>;
  resolveConfirmation(confirmationId: string, decision: 'approve' | 'deny'): Promise<ToolDispatchResult>;
}

export interface ToolRouterOptions {
  registry: ToolRegistry;
  confirmations: ConfirmationStore;
  auditLog: AuditLog;
}

export function createToolRouter(options: ToolRouterOptions): ToolRouter {
  const { registry, confirmations, auditLog } = options;

  const executeTool = async (
    entry: ToolEntry,
    request: ToolDispatchRequest,
    toolCallId: string,
  ): Promise<ToolDispatchResult> => {
    const startedAt = Date.now();
    try {
      const result = await entry.handler(request.args, {
        conversationId: request.conversationId,
        toolCallId,
      });
      auditLog.update(toolCallId, {
        status: entry.blastRadius === 'high' ? 'confirmed' : 'allowed',
        latencyMs: Date.now() - startedAt,
        cost: 0,
      });
      return { status: 'completed', result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      auditLog.update(toolCallId, {
        status: 'errored',
        error: message,
        latencyMs: Date.now() - startedAt,
      });
      return { status: 'errored', error: message };
    }
  };

  return {
    async dispatch(request): Promise<ToolDispatchResult> {
      const entry = registry.get(request.toolName);
      if (!entry || entry.status === 'disabled') {
        return {
          status: 'unavailable',
          error: `capability ${request.toolName} is unavailable`,
        };
      }

      const validation = validateArgs(entry.argsSchema, request.args);
      if (validation.length > 0) {
        auditLog.record({
          conversationId: request.conversationId,
          toolName: request.toolName,
          args: request.args,
          status: 'errored',
          error: validation.join('; '),
        });
        return { status: 'invalid_args', errors: validation };
      }

      const audit = auditLog.record({
        conversationId: request.conversationId,
        toolName: request.toolName,
        args: request.args,
        status: entry.blastRadius === 'high' ? 'pending_confirmation' : 'allowed',
      });

      if (entry.blastRadius === 'high') {
        const confirmation = confirmations.create({
          toolCallId: audit.id,
          conversationId: request.conversationId,
          toolName: request.toolName,
          args: request.args,
          blastReason: blastReasonFor(entry),
        });
        auditLog.update(audit.id, { confirmationId: confirmation.id });
        return {
          status: 'pending_confirmation',
          confirmationId: confirmation.id,
          message: `Confirm: ${entry.name}. Why this needs confirmation: ${confirmation.blastReason}`,
        };
      }

      return executeTool(entry, request, audit.id);
    },

    async resolveConfirmation(confirmationId, decision): Promise<ToolDispatchResult> {
      const current = confirmations.get(confirmationId);
      if (!current) {
        return { status: 'unavailable', error: `confirmation ${confirmationId} is unavailable` };
      }

      if (decision === 'deny') {
        const denied = confirmations.deny(confirmationId);
        auditLog.update(denied.toolCallId, { status: 'denied' });
        return { status: 'denied', error: 'confirmation denied' };
      }

      const approved = confirmations.approve(confirmationId);
      if (approved.status === 'denied') return { status: 'denied', error: 'confirmation denied' };
      if (approved.status === 'expired') return { status: 'expired', error: 'confirmation timed out' };
      if (approved.status !== 'approved') {
        return { status: 'errored', error: `confirmation ${confirmationId} is ${approved.status}` };
      }

      const entry = registry.get(approved.toolName);
      if (!entry || entry.status === 'disabled') {
        auditLog.update(approved.toolCallId, {
          status: 'errored',
          error: `capability ${approved.toolName} is unavailable`,
        });
        return { status: 'unavailable', error: `capability ${approved.toolName} is unavailable` };
      }

      return executeTool(
        entry,
        {
          conversationId: approved.conversationId,
          toolName: approved.toolName,
          args: approved.args,
        },
        approved.toolCallId,
      );
    },
  };
}

function blastReasonFor(entry: ToolEntry): string {
  return `high-blast-radius capability in ${entry.subsystem}`;
}

function validateArgs(schema: JsonSchema, value: unknown, path = 'args'): string[] {
  const errors: string[] = [];
  if (!matchesType(schema.type, value)) {
    return [`${path} must be ${schema.type}`];
  }

  if (schema.type !== 'object') return errors;
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const field of required) {
    if (!(field in record)) errors.push(`${path}.${field} is required`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (!(key in record)) continue;
    errors.push(...validateArgs(childSchema, record[key], `${path}.${key}`));
  }

  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}
