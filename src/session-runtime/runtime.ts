// src/session-runtime/runtime.ts
import type { Config } from '../config.js';
import type { SessionType, AgentDefinition, SessionContext, SessionResult } from '../types.js';
import type { Result } from '../lib/result.js';
import { ok, err } from '../lib/result.js';
import { CostTracker } from './cost.js';
import { createAdapter, type ProviderAdapter } from './adapters/index.js';

// Minimal agent registry — maps session types to definitions
// In MVP, we use a simple record. Full registry in later chunks.
const DEFAULT_AGENT_DEFS: Partial<Record<SessionType, AgentDefinition>> = {
  worker: {
    name: 'worker',
    description: 'Implements a unit of work',
    systemPrompt: 'You are an implementation worker.',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    timeoutMs: 600_000, // 10 min
    budgetCap: 5,
  },
  classifier: {
    name: 'classifier',
    description: 'Classifies work request complexity',
    systemPrompt: 'You classify work request complexity.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: 60_000,
    budgetCap: 0.5,
  },
  reporter: {
    name: 'reporter',
    description: 'Generates completion reports',
    systemPrompt: 'You generate structured reports.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: 60_000,
    budgetCap: 0.5,
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
    const prompt = this.assemblePrompt(def, context);

    // 5. Delegate to adapter
    const result = await this.adapter.spawn(def, prompt, {
      cwd: context.workspacePath,
      jsonSchema: options?.jsonSchema,
    });

    // 6. Record cost
    if (result.ok) {
      this.costTracker.recordCost(issueNumber, result.value.cost);
    }

    return result;
  }

  private assemblePrompt(def: AgentDefinition, context: SessionContext): string {
    let prompt = def.systemPrompt;
    for (const [key, value] of Object.entries(context.variables)) {
      prompt += `\n\n## ${key}\n${value}`;
    }
    return prompt;
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }
}
