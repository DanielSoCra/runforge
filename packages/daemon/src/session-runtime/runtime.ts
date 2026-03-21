// src/session-runtime/runtime.ts
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Config } from '../config.js';
import type { SessionType, AgentDefinition, SessionContext, SessionResult } from '../types.js';
import type { Result } from '../lib/result.js';
import { ok, err } from '../lib/result.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { CostTracker } from './cost.js';
import { createAdapter, type ProviderAdapter } from './adapters/index.js';
import { buildCompositeContext } from './plugin-injection.js';
import { readPluginsForContext } from './plugin-loader.js';
import { DEFAULT_POLICY } from './containment-hooks.js';

/** Resolve the prompts/ directory at the repo root. */
function promptsDir(): string {
  return process.env['PROMPTS_DIR'] ?? join(import.meta.dirname, '../../../../prompts');
}

/**
 * Load a prompt template from prompts/{name}.md and substitute {{variable}} placeholders.
 * Returns null if the file does not exist (caller falls back to def.systemPrompt).
 */
export async function loadPromptTemplate(
  name: string,
  variables: Record<string, string>,
): Promise<string | null> {
  // Guard against path traversal — agent names must be simple identifiers
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  const filePath = join(promptsDir(), `${name}.md`);
  try {
    let template = await readFile(filePath, 'utf-8');
    for (const [key, value] of Object.entries(variables)) {
      template = template.replaceAll(`{{${key}}}`, value);
    }
    return template;
  } catch (e: unknown) {
    // Only treat "file not found" as a graceful fallback.
    // Re-throw permission errors, encoding issues, etc. so they surface
    // rather than silently producing the same empty-prompt bug this fixes.
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

// Agent definition registry — maps session types to their operational parameters.
// System prompts are placeholders here; the real content lives in prompts/*.md
// and is loaded by the template renderer at runtime.
const DEFAULT_AGENT_DEFS: Record<SessionType, AgentDefinition> = {
  coordinator: {
    name: 'coordinator',
    description: 'Decomposes work requests into parallel task graphs',
    systemPrompt: '', // loaded from prompts/coordinator.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: 120_000,
    budgetCap: 1,
  },
  classifier: {
    name: 'classifier',
    description: 'Classifies work request complexity (simple/standard/complex)',
    systemPrompt: '', // loaded from prompts/classifier.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: 60_000,
    budgetCap: 0.5,
  },
  worker: {
    name: 'worker',
    description: 'Implements a unit of work using TDD',
    systemPrompt: '', // loaded from prompts/worker.md
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    timeoutMs: 600_000,
    budgetCap: 5,
  },
  'reviewer-spec': {
    name: 'reviewer-spec',
    description: 'Verifies implementation against spec acceptance criteria',
    systemPrompt: '', // loaded from prompts/reviewer-spec.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: 180_000,
    budgetCap: 2,
  },
  'reviewer-quality': {
    name: 'reviewer-quality',
    description: 'Evaluates code quality, patterns, and test quality',
    systemPrompt: '', // loaded from prompts/reviewer-quality.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: 180_000,
    budgetCap: 2,
  },
  'reviewer-security': {
    name: 'reviewer-security',
    description: 'Evaluates security: injection, auth, validation, concurrency',
    systemPrompt: '', // loaded from prompts/reviewer-security.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: 180_000,
    budgetCap: 2,
  },
  'conflict-resolver': {
    name: 'conflict-resolver',
    description: 'Resolves merge conflicts favoring spec intent',
    systemPrompt: '', // loaded from prompts/conflict-resolver.md
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: 120_000,
    budgetCap: 1,
  },
  'bug-worker': {
    name: 'bug-worker',
    description: 'Fixes Type A bugs with regression-test-first protocol',
    systemPrompt: '', // loaded from prompts/bug-worker.md
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 30,
    timeoutMs: 600_000,
    budgetCap: 5,
  },
  tester: {
    name: 'tester',
    description: 'Runs post-deployment tests and reports results',
    systemPrompt: '', // loaded from prompts/tester.md
    allowedTools: ['Read', 'Bash', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: 300_000,
    budgetCap: 1,
  },
  diagnostician: {
    name: 'diagnostician',
    description: 'Classifies bugs as Type A/B/C with confidence score',
    systemPrompt: '', // loaded from prompts/diagnostician.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: 120_000,
    budgetCap: 1,
  },
  reporter: {
    name: 'reporter',
    description: 'Generates structured completion reports',
    systemPrompt: '', // loaded from prompts/reporter.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: 60_000,
    budgetCap: 0.5,
  },
  'prompt-optimizer': {
    name: 'prompt-optimizer',
    description: 'Proposes improvements to mutable instruction templates',
    systemPrompt: '', // loaded from prompts/prompt-optimizer.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 5,
    timeoutMs: 300_000,
    budgetCap: 3,
  },
};

export class SessionRuntime {
  private adapter: ProviderAdapter;
  private costTracker: CostTracker;
  private lastSpawnTime = 0;
  private staggerMs: number;

  constructor(config: Config, costTracker: CostTracker) {
    this.adapter = createAdapter(config.adapter);
    this.costTracker = costTracker;
    this.staggerMs = 2000; // 2 second stagger between session starts
  }

  async spawnSession(
    type: SessionType,
    context: SessionContext,
    issueNumber: number,
    options?: { jsonSchema?: string; agentDef?: AgentDefinition },
    runWriter?: SupabaseRunWriter,
    runId?: string,
  ): Promise<Result<SessionResult>> {
    // 1. Look up agent definition
    const def = options?.agentDef ?? DEFAULT_AGENT_DEFS[type];
    if (!def) {
      return err(new Error(`No agent definition for session type: ${type}`));
    }

    // 2. Check budget
    const budget = this.costTracker.checkBudget(issueNumber);
    if (!budget.available) {
      return err(new Error(`Budget exceeded: ${budget.reason}`));
    }

    // 3. Stagger delay
    const now = Date.now();
    const elapsed = now - this.lastSpawnTime;
    if (elapsed < this.staggerMs) {
      await new Promise((resolve) => setTimeout(resolve, this.staggerMs - elapsed));
    }
    this.lastSpawnTime = Date.now();

    // 4. Assemble prompt
    const prompt = await this.assemblePrompt(def, context);

    // 5. Delegate to adapter — with containment policy enforced via PreToolUse hooks
    const result = await this.adapter.spawn(def, prompt, {
      cwd: context.workspacePath,
      jsonSchema: options?.jsonSchema,
      containmentPolicy: DEFAULT_POLICY,
    });

    // 6. Record cost
    if (result.ok) {
      this.costTracker.recordCost(issueNumber, result.value.cost);
      if (runWriter && runId) {
        void runWriter.writeCostEvent(runId, type, result.value.cost);
      }
    }

    return result;
  }

  private async assemblePrompt(def: AgentDefinition, context: SessionContext): Promise<string> {
    // Load the prompt template from prompts/{name}.md with {{variable}} substitution.
    // Falls back to def.systemPrompt + appended variables if template file is missing.
    const template = await loadPromptTemplate(def.name, context.variables);
    let prompt: string;
    if (template !== null) {
      prompt = template;
    } else {
      prompt = def.systemPrompt;
      for (const [key, value] of Object.entries(context.variables)) {
        prompt += `\n\n## ${key}\n${value}`;
      }
    }

    // If no active plugins, return prompt as-is
    if (!context.activePlugins?.length) return prompt;

    const pluginIds = context.activePlugins.map(e => e.id);
    const activations = new Map(context.activePlugins.map(e => [e.id, e.activatedAt]));
    const loaded = await readPluginsForContext(pluginIds, activations);
    const composite = buildCompositeContext(loaded);

    const parts: string[] = [];
    if (composite.promptInjection) parts.push(composite.promptInjection);
    for (const skill of composite.skills) {
      if (skill.content) parts.push(skill.content);
    }
    for (const agent of composite.agents) {
      if (agent.content) parts.push(agent.content);
    }
    if (parts.length === 0) return prompt;
    return `${parts.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }
}
