import { describe, expect, it } from 'vitest';
import { createConfirmationStore } from '../confirmation/state-machine.js';
import { createToolRegistry, type ToolEntry } from '../tools/registry.js';
import { createConciergeCore } from './concierge.js';

const statusTool: ToolEntry = {
  name: 'ac_status',
  description: 'Read daemon status',
  argsSchema: { type: 'object', additionalProperties: false, properties: {} },
  handler: async () => ({ paused: true }),
  blastRadius: 'safe',
  audit: 'always',
  cacheable: false,
  subsystem: 'auto-claude',
  governingSpecId: 'FUNC-AC-CONTROL-PLANE',
  status: 'enabled',
};

describe('concierge core', () => {
  it('acts on mapped operator intent and maintains conversation coherence', async () => {
    const core = createConciergeCore({
      registry: createToolRegistry([statusTool]),
      confirmations: createConfirmationStore(),
      planner: async () => ({ kind: 'tool', toolName: 'ac_status', args: {} }),
    });

    const first = await core.handleOperatorMessage({ text: 'daemon status' });
    const second = await core.handleOperatorMessage({
      conversationId: first.conversationId,
      text: 'and again',
    });

    expect(first.reply).toContain('ac_status completed');
    expect(second.conversation.turns.map((turn) => turn.role)).toEqual([
      'operator',
      'assistant',
      'operator',
      'assistant',
    ]);
  });

  it('declines out-of-scope requests when no capability maps to intent', async () => {
    const core = createConciergeCore({
      registry: createToolRegistry([statusTool]),
      confirmations: createConfirmationStore(),
      planner: async () => ({ kind: 'none' }),
    });

    const response = await core.handleOperatorMessage({ text: 'make coffee' });

    expect(response.reply).toContain('I cannot do that');
  });

  it('proposes a reusable shortcut after the same procedure repeats', async () => {
    const core = createConciergeCore({
      registry: createToolRegistry([statusTool]),
      confirmations: createConfirmationStore(),
      shortcutThreshold: 3,
      planner: async () => ({
        kind: 'procedure',
        name: 'morning-daemon-check',
        steps: [
          { toolName: 'ac_status', args: {} },
          { toolName: 'ac_status', args: {} },
        ],
      }),
    });

    await core.handleOperatorMessage({ text: 'morning check' });
    await core.handleOperatorMessage({ text: 'morning check' });
    const third = await core.handleOperatorMessage({ text: 'morning check' });

    expect(third.reply).toContain('Save recurring procedure morning-daemon-check?');
    expect(core.listShortcutProposals()).toEqual([
      expect.objectContaining({ name: 'morning-daemon-check', status: 'pending' }),
    ]);
  });
});
