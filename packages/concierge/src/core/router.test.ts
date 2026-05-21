import { describe, expect, it } from 'vitest';
import { createConfirmationStore } from '../confirmation/state-machine.js';
import { createToolRegistry, type ToolEntry } from '../tools/registry.js';
import { createAuditLog } from './audit-log.js';
import { createToolRouter } from './router.js';

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    name: 'ac_status',
    description: 'Read daemon status',
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: async () => ({ paused: true }),
    blastRadius: 'safe',
    audit: 'always',
    cacheable: false,
    subsystem: 'auto-claude',
    governingSpecId: 'FUNC-AC-CONTROL-PLANE',
    status: 'enabled',
    ...overrides,
  };
}

describe('tool router', () => {
  it('executes low-blast-radius capabilities immediately and audits the call', async () => {
    const auditLog = createAuditLog();
    const router = createToolRouter({
      registry: createToolRegistry([tool()]),
      confirmations: createConfirmationStore(),
      auditLog,
    });

    const result = await router.dispatch({
      conversationId: 'conv-1',
      toolName: 'ac_status',
      args: {},
    });

    expect(result).toEqual({ status: 'completed', result: { paused: true } });
    expect(auditLog.list()).toEqual([
      expect.objectContaining({ toolName: 'ac_status', status: 'allowed' }),
    ]);
  });

  it('returns unavailable for unknown capabilities without inventing a handler', async () => {
    const auditLog = createAuditLog();
    const router = createToolRouter({
      registry: createToolRegistry([tool()]),
      confirmations: createConfirmationStore(),
      auditLog,
    });

    const result = await router.dispatch({
      conversationId: 'conv-1',
      toolName: 'missing_tool',
      args: {},
    });

    expect(result.status).toBe('unavailable');
    expect(auditLog.list()).toEqual([]);
  });

  it('rejects invalid args before invoking a handler', async () => {
    let called = false;
    const router = createToolRouter({
      registry: createToolRegistry([
        tool({
          argsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['issue'],
            properties: { issue: { type: 'number' } },
          },
          handler: async () => {
            called = true;
            return {};
          },
        }),
      ]),
      confirmations: createConfirmationStore(),
      auditLog: createAuditLog(),
    });

    const result = await router.dispatch({
      conversationId: 'conv-1',
      toolName: 'ac_status',
      args: { issue: '504', extra: true },
    });

    expect(result.status).toBe('invalid_args');
    expect(called).toBe(false);
  });

  it('queues high-blast-radius capabilities for confirmation before execution', async () => {
    let called = false;
    const confirmations = createConfirmationStore({ now: () => 2_000 });
    const auditLog = createAuditLog();
    const router = createToolRouter({
      registry: createToolRegistry([
        tool({
          name: 'mail_send',
          description: 'Send external email',
          blastRadius: 'high',
          handler: async () => {
            called = true;
            return { sent: true };
          },
        }),
      ]),
      confirmations,
      auditLog,
    });

    const pending = await router.dispatch({
      conversationId: 'conv-1',
      toolName: 'mail_send',
      args: {},
    });

    expect(pending.status).toBe('pending_confirmation');
    expect(called).toBe(false);
    expect(confirmations.list()).toEqual([
      expect.objectContaining({ status: 'pending', toolName: 'mail_send' }),
    ]);
    expect(auditLog.list()[0]).toEqual(expect.objectContaining({ status: 'pending_confirmation' }));

    const confirmationId = pending.status === 'pending_confirmation' ? pending.confirmationId : '';
    const approved = await router.resolveConfirmation(confirmationId, 'approve');

    expect(approved).toEqual({ status: 'completed', result: { sent: true } });
    expect(called).toBe(true);
    expect(auditLog.list().at(-1)).toEqual(expect.objectContaining({ status: 'confirmed' }));
  });
});
