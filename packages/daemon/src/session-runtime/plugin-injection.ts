export interface SkillDoc { name: string; content: string; pluginId: string; }
export interface McpConfig { name: string; command: string; args: string[]; env?: Record<string, string>; }
export interface LoadedPlugin {
  id: string;
  activatedAt: string;
  promptInjection: string;
  skills: SkillDoc[];
  agents: SkillDoc[];
  mcpConfigs: McpConfig[];
  gates: string[];
}

export interface CompositeContext {
  promptInjection: string;
  skills: SkillDoc[];
  agents: SkillDoc[];
  mcpConfigs: McpConfig[];
  gates: string[];
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(ctx: CompositeContext): number {
  const text = ctx.skills.map(s => s.content).join('') +
    ctx.agents.map(a => a.content).join('') +
    ctx.promptInjection;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function buildCompositeContext(
  plugins: LoadedPlugin[],
  options: { tokenBudget?: number } = {},
): CompositeContext {
  const tokenBudget = options.tokenBudget ?? 20000;
  const sorted = [...plugins].sort((a, b) => a.activatedAt.localeCompare(b.activatedAt));

  const promptParts: string[] = [];
  const skillMap = new Map<string, SkillDoc>();
  const agentMap = new Map<string, SkillDoc>();
  const mcpMap = new Map<string, McpConfig>();
  const gates: string[] = [];

  // De-duplication uses a Map to preserve insertion order (guaranteed by ECMAScript spec).
  // `sorted` is ordered ascending by activatedAt, so Map insertion order == activation order.
  // First plugin to provide a skill/agent name wins (earliest activation wins on conflict).
  // [...skillMap.values()] produces an array in that same order — earliest first, latest last.
  // Under token budget pressure, pop() drops the last element (latest-activated plugin's
  // unique skill/agent) — intentionally shedding the most recently added content first.
  for (const plugin of sorted) {
    if (plugin.promptInjection) promptParts.push(plugin.promptInjection);
    for (const skill of plugin.skills) {
      if (!skillMap.has(skill.name)) skillMap.set(skill.name, skill);
    }
    for (const agent of plugin.agents) {
      if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
    }
    for (const mcp of plugin.mcpConfigs) {
      if (!mcpMap.has(mcp.name)) mcpMap.set(mcp.name, mcp);
    }
    gates.push(...plugin.gates);
  }

  const ctx: CompositeContext = {
    promptInjection: promptParts.join('\n\n---\n\n'),
    skills: [...skillMap.values()],
    agents: [...agentMap.values()],
    mcpConfigs: [...mcpMap.values()],
    gates,
  };

  // Apply token budget: preserve promptInjection, drop skills before agents, last-activated first
  while (estimateTokens(ctx) > tokenBudget) {
    if (ctx.skills.length > 0) {
      const dropped = ctx.skills.pop()!; // last-in = last-activated (sorted ascending, last = latest)
      console.warn(`[plugins] token budget exceeded — dropped skill: ${dropped.pluginId}/${dropped.name}`);
    } else if (ctx.agents.length > 0) {
      const dropped = ctx.agents.pop()!;
      console.warn(`[plugins] token budget exceeded — dropped agent: ${dropped.pluginId}/${dropped.name}`);
    } else {
      break;
    }
  }

  return ctx;
}
