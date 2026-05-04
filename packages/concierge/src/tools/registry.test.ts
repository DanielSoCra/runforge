import { describe, expect, it } from 'vitest';
import { createToolRegistry, type ToolEntry } from './registry.js';

const statusTool: ToolEntry = {
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
  cacheable: true,
  subsystem: 'auto-claude',
  governingSpecId: 'FUNC-AC-CONTROL-PLANE',
  status: 'enabled',
};

describe('tool registry', () => {
  it('registers namespaced tools and renders stable LLM definitions', () => {
    const registry = createToolRegistry([statusTool]);

    expect(registry.get('ac_status')).toBe(statusTool);
    expect(registry.toToolDefinitions()).toEqual([
      {
        name: 'ac_status',
        description: 'Read daemon status',
        input_schema: statusTool.argsSchema,
      },
    ]);
  });

  it('rejects duplicate tool names at startup', () => {
    expect(() => createToolRegistry([statusTool, statusTool])).toThrow(/duplicate tool name ac_status/);
  });

  it('rejects non-namespaced tool names', () => {
    expect(() => createToolRegistry([{ ...statusTool, name: 'status' }])).toThrow(/must be namespaced/);
  });
});
