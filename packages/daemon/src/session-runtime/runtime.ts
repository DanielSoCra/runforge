// src/session-runtime/runtime.ts
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Config } from '../config.js';
import type { SessionType, AgentDefinition, SessionContext, SessionResult } from '../types.js';
import type { Result } from '../lib/result.js';
import { ok, err } from '../lib/result.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { CostTracker } from './cost.js';
import { RateLimiter } from './rate-limiter.js';
import { createAdapter, type ProviderAdapter } from './adapters/index.js';
import { buildCompositeContext, type McpConfig } from './plugin-injection.js';
import { readPluginsForContext } from './plugin-loader.js';
import { DEFAULT_POLICY } from './containment-hooks.js';
import { SessionError } from './session-error.js';
import { auditSessionOutput } from './audit.js';
import { renderTemplate, findUnsubstitutedVars } from '../knowledge/templates.js';

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
    const template = await readFile(filePath, 'utf-8');
    const missing = findUnsubstitutedVars(template, variables);
    if (missing.length > 0) {
      console.warn(
        `[prompt-template] ${name}.md has unsubstituted variables: ${missing.join(', ')}. ` +
        `These will appear as literal {{var}} in the LLM prompt.`,
      );
    }
    return renderTemplate(template, variables);
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
// All timeouts set to 3 hours initially — gather real duration data first,
// then tune down per session type based on actual p95 durations.
const THREE_HOURS = 10_800_000;

const DEFAULT_AGENT_DEFS: Record<SessionType, AgentDefinition> = {
  coordinator: {
    name: 'coordinator',
    description: 'Decomposes work requests into parallel task graphs',
    systemPrompt: '', // loaded from prompts/coordinator.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: THREE_HOURS,
    budgetCap: 1,
  },
  classifier: {
    name: 'classifier',
    description: 'Classifies work request complexity (simple/standard/complex)',
    systemPrompt: '', // loaded from prompts/classifier.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: THREE_HOURS,
    budgetCap: 0.5,
  },
  worker: {
    name: 'worker',
    description: 'Implements a unit of work using TDD',
    systemPrompt: '', // loaded from prompts/worker.md
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    timeoutMs: THREE_HOURS,
    budgetCap: 5,
  },
  'reviewer-spec': {
    name: 'reviewer-spec',
    description: 'Verifies implementation against spec acceptance criteria',
    systemPrompt: '', // loaded from prompts/reviewer-spec.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'reviewer-quality': {
    name: 'reviewer-quality',
    description: 'Evaluates code quality, patterns, and test quality',
    systemPrompt: '', // loaded from prompts/reviewer-quality.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'reviewer-security': {
    name: 'reviewer-security',
    description: 'Evaluates security: injection, auth, validation, concurrency',
    systemPrompt: '', // loaded from prompts/reviewer-security.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'bug-worker': {
    name: 'bug-worker',
    description: 'Fixes Type A bugs with regression-test-first protocol',
    systemPrompt: '', // loaded from prompts/bug-worker.md
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 5,
  },
  diagnostician: {
    name: 'diagnostician',
    description: 'Classifies bugs as Type A/B/C with confidence score',
    systemPrompt: '', // loaded from prompts/diagnostician.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 1,
    timeoutMs: THREE_HOURS,
    budgetCap: 1,
  },
  'codebase-reviewer': {
    name: 'codebase-reviewer',
    description: 'Periodic codebase review — discovery, verification, filtered issue creation',
    systemPrompt: '', // loaded from prompts/codebase-reviewer.md
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 3,
  },
  'product-owner': {
    name: 'product-owner',
    description: 'Analyzes signals and generates business-level proposals',
    systemPrompt: '', // loaded from prompts/product-owner.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 3,
  },
  'tech-lead': {
    name: 'tech-lead',
    description: 'Analyzes technical signals and generates improvement proposals',
    systemPrompt: '', // loaded from prompts/tech-lead.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 3,
  },
  'l2-designer': {
    name: 'l2-designer',
    description: 'Generates L2 architecture specs from L1 functional specs',
    systemPrompt: 'You are an L2 architecture spec designer. Use the spec-brainstorm-l2 and l2-spec-guardian skills. Generate or update the ARCH-* spec file in .specify/architecture/. Commit the result.',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    maxTurns: 30,
    timeoutMs: 10_800_000, // 3 hours — spec generation is complex multi-step work
    budgetCap: 2,
  },
  'l3-generator': {
    name: 'l3-generator',
    description: 'Generates L3 stack-specific specs from approved L2 architecture specs',
    systemPrompt: 'You are an L3 spec generator. Use the spec-generate-l3 and l3-spec-guardian skills. Generate the STACK-* spec file in .specify/stack/. Run spec-review-compliance in inline mode as self-check. Commit the result.',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    maxTurns: 30,
    timeoutMs: 10_800_000, // 3 hours
    budgetCap: 2,
  },
  'compliance-reviewer': {
    name: 'compliance-reviewer',
    description: 'Reviews L3 specs for compliance with L1 and L2 specs',
    systemPrompt: 'You are a spec compliance reviewer. Use the spec-review-compliance skill to verify the L3 spec is consistent with L1 and L2. Report pass/fail with specific gaps found.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 15,
    timeoutMs: 10_800_000, // 3 hours
    budgetCap: 1,
  },
};

export class SessionRuntime {
  private adapter: ProviderAdapter;
  private costTracker: CostTracker;
  private rateLimiter: RateLimiter;
  private lastSpawnTime = 0;
  private staggerMs: number;

  constructor(config: Config, costTracker: CostTracker, rateLimiter?: RateLimiter) {
    this.adapter = createAdapter(config.adapter);
    this.costTracker = costTracker;
    this.rateLimiter = rateLimiter ?? new RateLimiter();
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

    // 2. Check budget — fail-safe guard clause (STACK-AC-OPERATIONAL-SAFETY)
    const budget = this.costTracker.checkBudget(issueNumber);
    if (!budget.available) {
      return err(SessionError.budgetExceeded(budget.reason));
    }

    // 3. Check rate limit (ARCH-AC-SESSION-RUNTIME step 3)
    const rateCheck = this.rateLimiter.checkRateLimit();
    if (!rateCheck.clear) {
      return err(SessionError.rateLimited(0, rateCheck.remainingMs));
    }

    // 4. Stagger delay
    const now = Date.now();
    const elapsed = now - this.lastSpawnTime;
    if (elapsed < this.staggerMs) {
      await new Promise((resolve) => setTimeout(resolve, this.staggerMs - elapsed));
    }
    this.lastSpawnTime = Date.now();

    // 5. Assemble prompt and extract plugin artifacts (ARCH-AC-PLUGINS Flow 4 step 3)
    const assembled = await this.assemblePrompt(def, context);

    // 6. Delegate to adapter — with containment policy and plugin MCP configs
    const result = await this.adapter.spawn(def, assembled.prompt, {
      cwd: context.workspacePath,
      jsonSchema: options?.jsonSchema,
      containmentPolicy: DEFAULT_POLICY,
      mcpConfigs: assembled.mcpConfigs,
    });

    // 7. Record cost — always, even on failure (ARCH-AC-SESSION-RUNTIME step 10)
    const cost = result.ok
      ? result.value.cost
      : result.error instanceof SessionError
        ? result.error.cost
        : 0;
    if (cost > 0) {
      this.costTracker.recordCost(issueNumber, cost);
      if (runWriter && runId) {
        void runWriter.writeCostEvent(runId, type, cost);
      }
    }

    // 8. Detect rate limit in adapter response (ARCH-AC-SESSION-RUNTIME rate limit detection flow)
    if (!result.ok && result.error instanceof SessionError && result.error.rateLimited) {
      this.rateLimiter.reportRateLimit();
    }

    // 9. Post-session audit — containment layer 6 (detective)
    // Scan output for references to prohibited paths (ARCH-AC-SESSION-RUNTIME step 9)
    // Scans path references and blocked command evidence (SEC-35).
    if (result.ok) {
      const audit = auditSessionOutput(result.value.output, DEFAULT_POLICY);
      if (!audit.clean) {
        return err(new SessionError(
          `Containment breach detected in post-session audit: ${audit.violations.join('; ')}`,
          result.value.cost,
          false,
          true,
        ));
      }
    }

    // 10. Attach plugin gates to result for downstream validation (ARCH-AC-PLUGINS Flow 4 step 3)
    if (result.ok && assembled.gates.length > 0) {
      result.value.pluginGates = assembled.gates;
    }

    return result;
  }

  private async assemblePrompt(
    def: AgentDefinition,
    context: SessionContext,
  ): Promise<{ prompt: string; mcpConfigs: McpConfig[]; gates: string[] }> {
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

    // If no active plugins, return prompt with empty plugin artifacts
    if (!context.activePlugins?.length) return { prompt, mcpConfigs: [], gates: [] };

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
    if (parts.length > 0) {
      prompt = `${parts.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
    }

    return { prompt, mcpConfigs: composite.mcpConfigs, gates: composite.gates };
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }
}
