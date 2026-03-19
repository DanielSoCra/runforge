import { describe, it, expect } from 'vitest';
import { buildCompositeContext, type LoadedPlugin } from './plugin-injection.js';

function makePlugin(id: string, activatedAt: string, overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id,
    activatedAt,
    promptInjection: `${id}-injection`,
    skills: [],
    agents: [],
    mcpConfigs: [],
    gates: [],
    ...overrides,
  };
}

describe('buildCompositeContext', () => {
  it('concatenates prompt injections in activatedAt order (earliest first)', () => {
    const plugins = [
      makePlugin('b', '2024-01-02T00:00:00Z'),
      makePlugin('a', '2024-01-01T00:00:00Z'),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.promptInjection.indexOf('a-injection')).toBeLessThan(
      ctx.promptInjection.indexOf('b-injection'),
    );
  });

  it('first-activated plugin wins on skill filename collision', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { skills: [{ name: 'pat.md', content: 'a-content', pluginId: 'a' }] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { skills: [{ name: 'pat.md', content: 'b-content', pluginId: 'b' }] }),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.skills.filter(s => s.name === 'pat.md')).toHaveLength(1);
    expect(ctx.skills.find(s => s.name === 'pat.md')!.content).toBe('a-content');
  });

  it('unions MCP configs, first-activated wins on duplicate server name', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { mcpConfigs: [{ name: 'figma', command: 'npx', args: ['figma-a'] }] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { mcpConfigs: [{ name: 'figma', command: 'npx', args: ['figma-b'] }] }),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.mcpConfigs.filter(m => m.name === 'figma')).toHaveLength(1);
    expect(ctx.mcpConfigs.find(m => m.name === 'figma')!.args).toContain('figma-a');
  });

  it('truncates skills before agents when budget exceeded, preserving promptInjection', () => {
    const longSkill = { name: 'big.md', content: 'x'.repeat(100000), pluginId: 'a' };
    const plugins = [makePlugin('a', '2024-01-01T00:00:00Z', { skills: [longSkill] })];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 50 });
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.promptInjection).toContain('a-injection');
  });
});
