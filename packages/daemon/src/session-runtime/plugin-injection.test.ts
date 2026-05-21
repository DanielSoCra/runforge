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

  it('carries governance before plugin prompt injection', () => {
    const ctx = buildCompositeContext([
      makePlugin('plugin', '2024-01-01T00:00:00Z', { promptInjection: 'PLUGIN RULES' }),
    ], { governanceDocument: 'GOVERNANCE RULES' });

    expect(ctx.governanceDocument).toBe('GOVERNANCE RULES');
    const assembled = [ctx.governanceDocument, ctx.promptInjection].filter(Boolean).join('\n\n---\n\n');
    expect(assembled.indexOf('GOVERNANCE RULES')).toBeLessThan(assembled.indexOf('PLUGIN RULES'));
  });

  it('preserves governance when token budget is exceeded', () => {
    const ctx = buildCompositeContext([
      makePlugin('a', '2024-01-01T00:00:00Z', {
        promptInjection: 'x'.repeat(100000),
        skills: [{ name: 'big.md', content: 's'.repeat(100000), pluginId: 'a' }],
        agents: [{ name: 'agent.md', content: 'a'.repeat(100000), pluginId: 'a' }],
      }),
    ], { tokenBudget: 1, governanceDocument: 'GOVERNANCE MUST STAY' });

    expect(ctx.governanceDocument).toBe('GOVERNANCE MUST STAY');
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.agents).toHaveLength(0);
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

  it('first-activated plugin wins on agent filename collision', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { agents: [{ name: 'reviewer.md', content: 'a-agent', pluginId: 'a' }] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { agents: [{ name: 'reviewer.md', content: 'b-agent', pluginId: 'b' }] }),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.agents.filter(a => a.name === 'reviewer.md')).toHaveLength(1);
    expect(ctx.agents.find(a => a.name === 'reviewer.md')!.content).toBe('a-agent');
  });

  it('truncates skills before agents when budget exceeded, preserving promptInjection', () => {
    const longSkill = { name: 'big.md', content: 'x'.repeat(100000), pluginId: 'a' };
    const plugins = [makePlugin('a', '2024-01-01T00:00:00Z', { skills: [longSkill] })];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 50 });
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.promptInjection).toContain('a-injection');
  });

  it('accumulates gates from multiple plugins in activatedAt order', () => {
    const plugins = [
      makePlugin('b', '2024-01-02T00:00:00Z', { gates: ['lint', 'typecheck'] }),
      makePlugin('a', '2024-01-01T00:00:00Z', { gates: ['test'] }),
    ];
    const ctx = buildCompositeContext(plugins);
    // Sorted by activatedAt: a first, then b
    expect(ctx.gates).toEqual(['test', 'lint', 'typecheck']);
  });

  it('gates are additive — duplicates are NOT deduped (unlike skills/agents/mcpConfigs)', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { gates: ['lint'] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { gates: ['lint'] }),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.gates).toEqual(['lint', 'lint']);
  });

  it('returns empty gates array when no plugins provide gates', () => {
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z'),
      makePlugin('b', '2024-01-02T00:00:00Z'),
    ];
    const ctx = buildCompositeContext(plugins);
    expect(ctx.gates).toEqual([]);
  });

  it('drops agents after all skills are exhausted when budget still exceeded', () => {
    const longAgent = { name: 'big-agent.md', content: 'a'.repeat(100000), pluginId: 'a' };
    const plugins = [makePlugin('a', '2024-01-01T00:00:00Z', { agents: [longAgent] })];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 50 });
    expect(ctx.agents).toHaveLength(0);
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.promptInjection).toContain('a-injection');
  });

  it('drops skills first, then agents when both exceed budget', () => {
    const longSkill = { name: 'big-skill.md', content: 's'.repeat(50000), pluginId: 'a' };
    const longAgent = { name: 'big-agent.md', content: 'a'.repeat(50000), pluginId: 'a' };
    const plugins = [makePlugin('a', '2024-01-01T00:00:00Z', { skills: [longSkill], agents: [longAgent] })];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 50 });
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.agents).toHaveLength(0);
    expect(ctx.promptInjection).toContain('a-injection');
  });

  it('breaks when both skills and agents are empty but budget still exceeded', () => {
    // promptInjection alone exceeds budget — should not infinite loop
    const plugins = [makePlugin('a', '2024-01-01T00:00:00Z', { promptInjection: 'x'.repeat(100000) })];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 50 });
    expect(ctx.skills).toHaveLength(0);
    expect(ctx.agents).toHaveLength(0);
    expect(ctx.promptInjection).toBe('x'.repeat(100000));
  });

  it('drops last-activated agents first under budget pressure', () => {
    const agentA = { name: 'agent-a.md', content: 'a'.repeat(40000), pluginId: 'a' };
    const agentB = { name: 'agent-b.md', content: 'b'.repeat(40000), pluginId: 'b' };
    const plugins = [
      makePlugin('a', '2024-01-01T00:00:00Z', { agents: [agentA] }),
      makePlugin('b', '2024-01-02T00:00:00Z', { agents: [agentB] }),
    ];
    const ctx = buildCompositeContext(plugins, { tokenBudget: 12000 });
    expect(ctx.agents).toHaveLength(1);
    expect(ctx.agents[0]!.pluginId).toBe('a');
  });
});
