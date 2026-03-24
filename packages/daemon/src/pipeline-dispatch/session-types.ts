// session-types.ts — Pipeline dispatch types and static session type registry
// Governed by: STACK-AC-PIPELINE-DISPATCH

import type { AgentDefinition } from '../types.js';

// --- Value types ---

export type PipelineWorkType = 'l2-brainstorm' | 'l3-generate' | 'compliance-review' | 'implementation';

export type DispatchStatus = 'completed' | 'failed' | 'timed-out' | 'budget-exceeded' | 'rate-limited';

export interface DispatchRequest {
  sessionType: PipelineWorkType;
  context: { issueNumber: number; repo: string; feedback?: string };
  baseBranch: string; // always 'dev'
}

export interface DispatchResult {
  status: DispatchStatus;
  costIncurred: number;
  durationMs: number;
  summary: string;
  cooldownMs?: number; // present when status is 'rate-limited'
}

// --- Session type names (must match AgentDefinition names registered in Session Runtime) ---

export type PipelineSessionType = 'l2-designer' | 'l3-generator' | 'compliance-reviewer' | 'spec-implementer';

/**
 * Maps a pipeline work type to the corresponding session type name.
 * Exhaustive switch — TypeScript's `never` check catches missing cases.
 */
export function mapWorkTypeToSessionType(workType: PipelineWorkType): PipelineSessionType {
  switch (workType) {
    case 'l2-brainstorm': return 'l2-designer';
    case 'l3-generate': return 'l3-generator';
    case 'compliance-review': return 'compliance-reviewer';
    case 'implementation': return 'spec-implementer';
    default: {
      const _exhaustive: never = workType;
      throw new Error(`Unknown pipeline work type: ${_exhaustive}`);
    }
  }
}

// --- Static AgentDefinition registry ---

const PIPELINE_AGENT_DEFS: Record<PipelineSessionType, AgentDefinition> = {
  'l2-designer': {
    name: 'l2-designer',
    description: 'Designs L2 architecture specs from approved L1 functional specs',
    systemPrompt: '', // loaded from prompts/{name}.md at runtime
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    modelOverride: undefined, // higher-capability model tier (default)
    maxTurns: 50,
    timeoutMs: 600_000,
    budgetCap: 10,
  },
  'l3-generator': {
    name: 'l3-generator',
    description: 'Generates L3 stack-specific specs from approved L2 architecture specs',
    systemPrompt: '', // loaded from prompts/{name}.md at runtime
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    modelOverride: undefined,
    maxTurns: 50,
    timeoutMs: 600_000,
    budgetCap: 10,
  },
  'compliance-reviewer': {
    name: 'compliance-reviewer',
    description: 'Reviews L3 specs against L1/L2 for compliance',
    systemPrompt: '', // loaded from prompts/{name}.md at runtime
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: undefined,
    maxTurns: 10,
    timeoutMs: 180_000,
    budgetCap: 3,
  },
  'spec-implementer': {
    name: 'spec-implementer',
    description: 'Implements code from approved L3 specs using TDD',
    systemPrompt: '', // loaded from prompts/{name}.md at runtime
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    modelOverride: undefined,
    maxTurns: 80,
    timeoutMs: 900_000,
    budgetCap: 10,
  },
};

// Freeze the registry — no runtime mutation
Object.freeze(PIPELINE_AGENT_DEFS);
for (const def of Object.values(PIPELINE_AGENT_DEFS)) {
  Object.freeze(def);
  Object.freeze(def.allowedTools);
}

/**
 * Returns the frozen pipeline AgentDefinition registry.
 */
export function getPipelineAgentDefs(): Readonly<Record<PipelineSessionType, AgentDefinition>> {
  return PIPELINE_AGENT_DEFS;
}

/**
 * Returns the AgentDefinition for a given pipeline session type.
 * Throws if the session type is not registered (startup validation).
 */
export function getPipelineAgentDef(sessionType: PipelineSessionType): AgentDefinition {
  const def = PIPELINE_AGENT_DEFS[sessionType];
  if (!def) {
    throw new Error(`No pipeline agent definition for session type: ${sessionType}`);
  }
  return def;
}

/**
 * Validates that all four pipeline session types are registered.
 * Call at daemon startup to catch mismatches early (L3 gotcha: name mismatch
 * between here and Session Runtime causes runtime failure with no compile-time warning).
 */
export function validatePipelineSessionTypes(): void {
  const expected: PipelineSessionType[] = ['l2-designer', 'l3-generator', 'compliance-reviewer', 'spec-implementer'];
  for (const name of expected) {
    if (!PIPELINE_AGENT_DEFS[name]) {
      throw new Error(`Missing pipeline agent definition: ${name}`);
    }
  }
}
