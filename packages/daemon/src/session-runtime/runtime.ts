// src/session-runtime/runtime.ts
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { Config } from '../config.js';
import type {
  SessionType,
  AgentDefinition,
  SessionContext,
  SessionResult,
  ViolationRecord,
  ModelTier,
} from '../types.js';
import type { Result } from '../lib/result.js';
import { ok, err } from '../lib/result.js';
import type { RunWriter } from '../data/run-writer.js';
import { CostTracker, type CostReservation } from './cost.js';
import { RateLimiter } from './rate-limiter.js';
import {
  createAdapter,
  createProviderAdapter,
  type ProviderAdapter,
} from './adapters/index.js';
import { buildCompositeContext, type McpConfig } from './plugin-injection.js';
import { readPluginsForContext } from './plugin-loader.js';
import { loadGovernanceContext } from './governance-context.js';
import { DEFAULT_POLICY, policyForAgentType } from './containment-hooks.js';
import { SessionError } from './session-error.js';
import { auditSessionOutput } from './audit.js';
import {
  renderTemplate,
  findUnsubstitutedVars,
} from '../knowledge/templates.js';
import {
  assertContract,
  PROMPT_CONTRACTS,
} from '../knowledge/prompt-contracts.js';
import {
  buildScopeRegistry,
  resolveDirectoryScope,
  type ScopeRegistry,
} from './scope-registry.js';
import { auditScope, captureScopeBaseCommit } from './scope-audit.js';
import {
  classifyProviderFailure,
  ProviderRegistry,
} from './providers/registry.js';
import { deriveWorkspaceIdentity, type SessionResumeState } from './providers/resume-state.js';

export interface SpawnSessionOptions {
  jsonSchema?: string | object;
  agentDef?: AgentDefinition;
  costAttributionIssueNumbers?: number[];
}

type AdapterSpawnOptions = Parameters<ProviderAdapter['spawn']>[2];

/** Resolve the prompts/ directory at the repo root. */
function promptsDir(): string {
  return (
    process.env['PROMPTS_DIR'] ??
    join(import.meta.dirname, '../../../../prompts')
  );
}

function formatScopeViolations(violations: ViolationRecord[]): string {
  return violations
    .map(
      (v) =>
        `${v.violationType} ${v.path} (${v.detectionLayer}, ${v.agentType}, ${v.sessionId})`,
    )
    .join('; ');
}

/**
 * Cache prompt templates in memory after first read.
 *
 * The daemon's main repo HEAD can move between branches during normal pipeline
 * operation (`coordinator.implement` checks out the feature branch in the main
 * repo before merging; `integrateToStaging` checks out staging). When HEAD is
 * not on `dev`, prompts/worker.md and friends reflect whatever the *other*
 * branch happened to have — typically a stale version that lacks recent
 * orchestration fixes. Sessions spawned in that window get the wrong prompt.
 *
 * Caching once at first-load freezes the prompt to whatever the daemon process
 * saw at startup, which is always a known-good revision (the daemon was started
 * from a clean dev checkout). The cache lasts the lifetime of the daemon
 * process; a daemon restart picks up any updated prompt files. In test mode,
 * caching is bypassed so each test sees fresh file content.
 */
const promptCache = new Map<string, string>();
const isTestEnv = (): boolean =>
  process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';

/**
 * Pre-warm the prompt cache by reading every prompt template now,
 * while the daemon's main repo HEAD is still on its known-good startup branch.
 * Without this, the *first* loadPromptTemplate call for each prompt could land
 * mid-pipeline (after a phase moved HEAD to a feature branch) and cache the
 * stale version. Returns the number of prompts loaded.
 */
export async function preloadPromptCache(): Promise<number> {
  if (isTestEnv()) return 0;
  const dir = promptsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const promptFiles = entries.filter((f) => f.endsWith('.md'));
  let loaded = 0;
  for (const file of promptFiles) {
    const filePath = join(dir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      promptCache.set(filePath, content);
      loaded += 1;
    } catch {
      // Missing file is tolerated (loadPromptTemplate falls back to def.systemPrompt).
    }
  }
  return loaded;
}

/** Test-only: clear the cache between tests. */
export function __clearPromptCacheForTests(): void {
  promptCache.clear();
}

/**
 * Read a prompt template from the boot-frozen cache by its base name (e.g.
 * `product-owner-interactive`). Returns `undefined` when the prompt was not
 * frozen at boot. This is the self-hosting-safe way to access a prompt that
 * would otherwise be live-read off the moving working tree.
 */
export function getFrozenPromptTemplate(name: string): string | undefined {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return undefined;
  }
  return promptCache.get(join(promptsDir(), `${name}.md`));
}

/** Test-only: seed the cache between tests. */
export function __setPromptCacheForTests(name: string, content: string): void {
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..')
  ) {
    return;
  }
  promptCache.set(join(promptsDir(), `${name}.md`), content);
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

  const isRegistered = name in PROMPT_CONTRACTS;
  const isTest = isTestEnv();

  // Apply prompt contract: defaults for omitted keys + reject extras/missing.
  // In test mode we throw (CI catches drift); in production we warn and fall
  // back to defaults-applied variables so a contract bug never takes the
  // daemon down at runtime — startup validation is the hard gate.
  // Defaults are applied even on the fallback path so that, e.g., a registered
  // prompt with `feedback` default still substitutes `{{feedback}}` with `''`
  // rather than leaving it as a literal placeholder in the rendered output
  // (Codex review a2737b6).
  const defaults = PROMPT_CONTRACTS[name]?.defaults ?? {};
  const variablesWithDefaults: Record<string, string> = {
    ...defaults,
    ...variables,
  };
  let finalVars: Record<string, string>;
  try {
    finalVars = assertContract(name, variables);
  } catch (e) {
    if (isTest) throw e;
    console.warn(
      `[prompt-template] contract violation for ${name}: ${(e as Error).message}`,
    );
    finalVars = variablesWithDefaults;
  }

  const filePath = join(promptsDir(), `${name}.md`);
  try {
    let template: string;
    const cached = promptCache.get(filePath);
    if (cached !== undefined && !isTest) {
      template = cached;
    } else {
      template = await readFile(filePath, 'utf-8');
      if (!isTest) promptCache.set(filePath, template);
    }
    const missing = findUnsubstitutedVars(template, finalVars);
    if (missing.length > 0) {
      console.warn(
        `[prompt-template] ${name}.md has unsubstituted variables: ${missing.join(', ')}. ` +
          `These will appear as literal {{var}} in the LLM prompt.`,
      );
    }
    // Registered prompts in test mode also enforce no-unused at render time so
    // CI catches caller-passed variables that the template silently drops.
    const renderOptions =
      isRegistered && isTest ? ({ rejectUnused: true } as const) : undefined;
    return renderTemplate(template, finalVars, renderOptions);
  } catch (e: unknown) {
    // Only treat "file not found" as a graceful fallback.
    // Re-throw permission errors, encoding issues, etc. so they surface
    // rather than silently producing the same empty-prompt bug this fixes.
    if (
      e instanceof Error &&
      'code' in e &&
      (e as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
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

// Model routing: use the cheapest model that can handle each session type.
// haiku = trivial/1-turn, sonnet = read+analyze, opus = complex multi-step reasoning.
// undefined = user's default model (backward compat for API key users).
const DEFAULT_AGENT_DEFS: Record<SessionType, AgentDefinition> = {
  coordinator: {
    name: 'coordinator',
    description: 'Decomposes work requests into parallel task graphs',
    systemPrompt: '', // loaded from prompts/coordinator.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-haiku-4-5-20251001',
    maxTurns: 1,
    timeoutMs: THREE_HOURS,
    budgetCap: 1,
  },
  classifier: {
    name: 'classifier',
    description: 'Classifies work request complexity (simple/standard/complex)',
    systemPrompt: '', // loaded from prompts/classifier.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-haiku-4-5-20251001',
    maxTurns: 1,
    timeoutMs: THREE_HOURS,
    budgetCap: 0.5,
  },
  worker: {
    name: 'worker',
    description: 'Implements a unit of work using TDD',
    systemPrompt: '', // loaded from prompts/worker.md
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 50,
    timeoutMs: THREE_HOURS,
    budgetCap: 5,
  },
  'reviewer-spec': {
    name: 'reviewer-spec',
    description: 'Verifies implementation against spec acceptance criteria',
    systemPrompt: '', // loaded from prompts/reviewer-spec.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'reviewer-quality': {
    name: 'reviewer-quality',
    description: 'Evaluates code quality, patterns, and test quality',
    systemPrompt: '', // loaded from prompts/reviewer-quality.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'reviewer-security': {
    name: 'reviewer-security',
    description: 'Evaluates security: injection, auth, validation, concurrency',
    systemPrompt: '', // loaded from prompts/reviewer-security.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'bug-worker': {
    name: 'bug-worker',
    description: 'Fixes Type A bugs with regression-test-first protocol',
    systemPrompt: '', // loaded from prompts/bug-worker.md
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 5,
  },
  diagnostician: {
    name: 'diagnostician',
    description: 'Classifies bugs as Type A/B/C with confidence score',
    systemPrompt: '', // loaded from prompts/diagnostician.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-haiku-4-5-20251001',
    maxTurns: 1,
    timeoutMs: THREE_HOURS,
    budgetCap: 1,
  },
  'codebase-reviewer': {
    name: 'codebase-reviewer',
    description:
      'Periodic codebase review — discovery, verification, filtered issue creation',
    systemPrompt: '', // loaded from prompts/codebase-reviewer.md
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 3,
  },
  'product-owner': {
    name: 'product-owner',
    description: 'Analyzes signals and generates business-level proposals',
    systemPrompt: '', // loaded from prompts/product-owner.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 3,
  },
  'tech-lead': {
    name: 'tech-lead',
    description:
      'Analyzes technical signals and generates improvement proposals',
    systemPrompt: '', // loaded from prompts/tech-lead.md
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 10,
    timeoutMs: THREE_HOURS,
    budgetCap: 3,
  },
  'l2-designer': {
    name: 'l2-designer',
    description: 'Generates L2 architecture specs from L1 functional specs',
    systemPrompt:
      'You are an L2 architecture spec designer. Use the spec-brainstorm-l2 and l2-spec-guardian skills. Generate or update the ARCH-* spec file in .specify/architecture/. Commit the result.',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'l3-generator': {
    name: 'l3-generator',
    description:
      'Generates L3 stack-specific specs from approved L2 architecture specs',
    systemPrompt:
      'You are an L3 spec generator. Use the spec-generate-l3 and l3-spec-guardian skills. Generate the STACK-* spec file in .specify/stack/. Run spec-review-compliance in inline mode as self-check. Commit the result.',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 30,
    timeoutMs: THREE_HOURS,
    budgetCap: 2,
  },
  'compliance-reviewer': {
    name: 'compliance-reviewer',
    description: 'Reviews L3 specs for compliance with L1 and L2 specs',
    systemPrompt:
      'You are a spec compliance reviewer. Use the spec-review-compliance skill to verify the L3 spec is consistent with L1 and L2. Report pass/fail with specific gaps found.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 15,
    timeoutMs: THREE_HOURS,
    budgetCap: 1,
  },
};

/**
 * Applies the optional pilot runaway envelope (`config.workerCaps`) to a
 * resolved agent definition. Worker-only safety clamp:
 *
 * - Only definitions whose resolved `name === 'worker'` are clamped. This keys
 *   on the *resolved* def name, NOT the spawnSession `type`, so a non-worker
 *   per-spawn `agentDef` override (e.g. the `spec-implementer` pipeline def with
 *   maxTurns:80) routed through this method is left untouched.
 * - The clamp is `min(config, default)`: config can only LOWER maxTurns/timeoutMs,
 *   never raise them. This makes `workerCaps` a one-way tightening of the envelope.
 * - Returns the original def unchanged when no cap applies (no allocation on the
 *   common path); otherwise returns a shallow clone — the frozen DEFAULT_AGENT_DEFS
 *   and pipeline defs are never mutated.
 */
export function clampWorkerCaps(
  def: AgentDefinition,
  caps: Config['workerCaps'],
): AgentDefinition {
  if (!caps || def.name !== 'worker') return def;

  const maxTurns =
    caps.maxTurns !== undefined
      ? Math.min(def.maxTurns, caps.maxTurns)
      : def.maxTurns;
  const timeoutMs =
    caps.timeoutMs !== undefined
      ? Math.min(def.timeoutMs, caps.timeoutMs)
      : def.timeoutMs;

  if (maxTurns === def.maxTurns && timeoutMs === def.timeoutMs) return def;
  return { ...def, maxTurns, timeoutMs };
}

/**
 * Applies a per-agent-role model/provider override (`config.roleModels`) onto a
 * resolved agent definition. Thin config→def bridge for the dormant
 * multi-provider plumbing:
 *
 * - Keyed on `roleName` — the caller passes the *resolved* def name
 *   (`rawDef.name`), NOT the spawnSession `type`. This is what makes inline /
 *   pipeline defs that arrive via `options.agentDef` (e.g. `spec-implementer`,
 *   `batch-classifier`) overridable from the single spawnSession call-site,
 *   alongside the DEFAULT_AGENT_DEFS roles.
 * - Field mapping: `model` → `modelOverride` (the adapters read `modelOverride`);
 *   `modelTier`, `provider`, `providerBinding` are copied through. Only fields
 *   present on the override are touched — an override that sets just `provider`
 *   leaves the def's existing `modelOverride` intact.
 * - The def `name` is never changed, so a later `clampWorkerCaps` (which keys on
 *   `def.name === 'worker'`) still behaves correctly. Order at the call-site is
 *   model-first then clamp; the two are orthogonal (clamp only lowers
 *   maxTurns/timeoutMs).
 * - Returns the original def unchanged when there is no entry for the role (no
 *   allocation on the common path); otherwise returns a shallow clone — the
 *   frozen DEFAULT_AGENT_DEFS / pipeline defs are never mutated.
 *
 * NOTE: when the override routes to a provider whose definition sets its own
 * `model`, the adapter resolves `provider.model ?? def.modelOverride` — so the
 * provider's model WINS over a `roleModels.model` set here. Config validation
 * permits this; operators should leave `model` off the provider def if they want
 * the per-role `model` to take effect.
 */
export function applyRoleModel(
  def: AgentDefinition,
  roleName: string,
  roleModels: Config['roleModels'] | undefined,
): AgentDefinition {
  const override = roleModels?.[roleName];
  if (!override) return def;

  const next: AgentDefinition = { ...def };
  if (override.model !== undefined) next.modelOverride = override.model;
  if (override.modelTier !== undefined) next.modelTier = override.modelTier;
  if (override.provider !== undefined) next.provider = override.provider;
  if (override.providerBinding !== undefined) {
    next.providerBinding = override.providerBinding;
  }
  return next;
}

export class SessionRuntime {
  private adapter: ProviderAdapter;
  private costTracker: CostTracker;
  private rateLimiter: RateLimiter;
  private lastSpawnTime = 0;
  private staggerMs: number;
  private config: Config;
  private scopeRegistry: ScopeRegistry;
  private providerRegistry: ProviderRegistry;
  private useProviderRegistry: boolean;
  private skipPermissions: boolean;

  constructor(
    config: Config,
    costTracker: CostTracker,
    rateLimiter?: RateLimiter,
  ) {
    this.adapter = createAdapter(config.providers ? 'cli' : config.adapter);
    this.costTracker = costTracker;
    this.rateLimiter = rateLimiter ?? new RateLimiter();
    this.staggerMs = 2000; // 2 second stagger between session starts
    this.config = config;
    this.scopeRegistry = buildScopeRegistry(config.agentScopes ?? {});
    this.providerRegistry = ProviderRegistry.fromConfig(config);
    this.useProviderRegistry = config.providers !== undefined;
    // Trust/permission bypass for autonomous, externally-sandboxed workers.
    // Gated behind config.autonomous OR the AUTO_CLAUDE_SKIP_PERMISSIONS env so
    // a container deployment can flip it without re-baking the image, while
    // interactive/native runs stay off by default. Resolved once at construction
    // and passed into the adapter on every spawn (legacy + provider-fallback
    // paths). The daemon's PreToolUse containment hooks still gate every tool
    // call — see CliAdapter.buildArgs / setupHooks.
    this.skipPermissions =
      config.autonomous === true ||
      process.env['AUTO_CLAUDE_SKIP_PERMISSIONS'] === '1';
    if (this.skipPermissions) {
      console.log(
        '[runtime] Autonomous mode: workers clear the CLI workspace-trust gate ' +
          '(per-worktree trust seeding; --dangerously-skip-permissions when non-root). ' +
          'PreToolUse containment hooks remain active on every tool call.',
      );
    }
  }

  async spawnSession(
    type: SessionType,
    context: SessionContext,
    issueNumber: number,
    options?: SpawnSessionOptions,
    runWriter?: RunWriter,
    runId?: string,
  ): Promise<Result<SessionResult>> {
    // 1. Look up agent definition
    const rawDef = options?.agentDef ?? DEFAULT_AGENT_DEFS[type];
    if (!rawDef) {
      return err(new Error(`No agent definition for session type: ${type}`));
    }
    // Apply per-role model/provider override (config.roleModels), keyed on the
    // RESOLVED def name (rawDef.name) so inline/pipeline defs arriving via
    // options.agentDef (spec-implementer, batch-classifier) are overridable from
    // this one call-site too. Model-first, before the clamp below.
    const baseDef = applyRoleModel(rawDef, rawDef.name, this.config.roleModels);
    // Apply the optional pilot runaway envelope (config.workerCaps). Clamping
    // here — before budget reservation, prompt assembly, and adapter.spawn —
    // covers BOTH the legacy CLI adapter and the multi-provider fallback path,
    // since they each receive this resolved `def`. The clamp is worker-only and
    // can only LOWER caps (min), never raise them. applyRoleModel never changes
    // the def name, so this clamp still keys correctly.
    const def = clampWorkerCaps(baseDef, this.config.workerCaps);

    // 2. Reserve budget — fail-safe guard clause (STACK-AC-OPERATIONAL-SAFETY)
    const costAttributionIssueNumbers = normalizeCostAttributionIssueNumbers(
      options?.costAttributionIssueNumbers,
      issueNumber,
    );
    const budgetReservation = this.costTracker.reserveCost(
      costAttributionIssueNumbers,
      def.budgetCap,
    );
    if (!budgetReservation.reserved) {
      return err(SessionError.budgetExceeded(budgetReservation.reason));
    }

    try {
      // 3. Check legacy global rate limit (ARCH-AC-SESSION-RUNTIME step 3).
      // Multi-provider mode uses provider-local cooldowns in ProviderRegistry
      // so one rate-limited provider does not block healthy fallbacks.
      if (!this.useProviderRegistry) {
        const rateCheck = this.rateLimiter.checkRateLimit();
        if (!rateCheck.clear) {
          return err(SessionError.rateLimited(0, rateCheck.remainingMs));
        }
      }

      // 4. Stagger delay
      const now = Date.now();
      const elapsed = now - this.lastSpawnTime;
      if (elapsed < this.staggerMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.staggerMs - elapsed),
        );
      }
      this.lastSpawnTime = Date.now();

      // 5. Assemble prompt and extract plugin artifacts (ARCH-AC-PLUGINS Flow 4 step 3)
      let assembled: {
        prompt: string;
        mcpConfigs: McpConfig[];
        gates: string[];
      };
      try {
        assembled = await this.assemblePrompt(def, context);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }

      // 6. Delegate to adapter — with containment policy and plugin MCP configs.
      // jsonSchema may be passed as object (callers like l3-compliance use the
      // exported schema constant directly) or a pre-stringified string. Adapter
      // expects string for the CLI --json-schema arg, so serialize here.
      const jsonSchema =
        typeof options?.jsonSchema === 'object' && options.jsonSchema !== null
          ? JSON.stringify(options.jsonSchema)
          : options?.jsonSchema;
      const directoryScope =
        options?.agentDef?.directoryScope ??
        def.directoryScope ??
        resolveDirectoryScope(type, this.scopeRegistry, DEFAULT_POLICY);
      const scopeBaseCommit = context.workspacePath
        ? await this.tryCaptureScopeBaseCommit(context.workspacePath)
        : undefined;
      const adapterOptions = {
        cwd: context.workspacePath,
        jsonSchema,
        // Role-aware: spec-authoring roles (l2-designer/l3-generator) get
        // writableExceptions so they can write their own deliverable into the
        // otherwise read-only .specify/ tree. All other roles get DEFAULT_POLICY.
        containmentPolicy: policyForAgentType(type),
        mcpConfigs: assembled.mcpConfigs,
        directoryScope,
        skipPermissions: this.skipPermissions,
      };
      const result = this.useProviderRegistry
        ? await this.spawnWithProviderFallback(
            def,
            assembled.prompt,
            adapterOptions,
            type,
            costAttributionIssueNumbers,
            budgetReservation.reservation,
            runWriter,
            runId,
          )
        : await this.spawnWithLegacyAdapter(
            def,
            assembled.prompt,
            adapterOptions,
            type,
            costAttributionIssueNumbers,
            budgetReservation.reservation,
            runWriter,
            runId,
          );

      if (!result.ok) return result;

      if (context.workspacePath) {
        const scopeAudit = await auditScope({
          workspacePath: context.workspacePath,
          baseCommit: scopeBaseCommit,
          sessionId: `${type}-${issueNumber}`,
          agentType: type,
          scope: directoryScope,
        });
        if (!scopeAudit.ok) {
          return err(
            SessionError.scopeViolated(
              formatScopeViolations(scopeAudit.error),
              result.value.cost,
            ),
          );
        }
      }

      // 9. Post-session audit — containment layer 6 (detective).
      // Output-text scanning has high false-positive risk: model prose mentioning
      // command names (git, bash, python3) trips the regex even when no command
      // was executed. Preventive containment via Bash hooks (containment-hooks.ts)
      // is still terminal — that layer audits real tool invocations.
      //
      // Issue #489 acceptance criteria 5–6: blocked-command evidence stays advisory
      // (console.warn + auditWarnings), intentionally preserved. Credential-leak
      // matches are fatal and fail the session via the same terminal path as a
      // scope-audit hard-fail.
      const audit = auditSessionOutput(result.value.output, DEFAULT_POLICY);
      if (!audit.clean) {
        const fatal = audit.violations.filter((v) => v.severity === 'fatal');
        const advisory = audit.violations.filter((v) => v.severity === 'advisory');

        if (fatal.length > 0) {
          const details = fatal
            .map((v) => `${v.message} (redacted: ${v.redactedMatch})`)
            .join('; ');
          return err(SessionError.containmentBreached(details, result.value.cost));
        }

        if (advisory.length > 0) {
          console.warn(
            `[audit] Post-session output mentions blocked commands (advisory, not terminal): ${advisory.map((v) => v.message).join('; ')}`,
          );
          result.value.auditWarnings = advisory.map((v) => v.message);
        }
      }

      // 10. Attach plugin gates to result for downstream validation (ARCH-AC-PLUGINS Flow 4 step 3)
      if (assembled.gates.length > 0) {
        result.value.pluginGates = assembled.gates;
      }

      return result;
    } finally {
      this.costTracker.releaseCostReservation(budgetReservation.reservation);
    }
  }

  private async spawnWithLegacyAdapter(
    def: AgentDefinition,
    prompt: string,
    adapterOptions: AdapterSpawnOptions,
    type: SessionType,
    costAttributionIssueNumbers: number[],
    costReservation: CostReservation,
    runWriter?: RunWriter,
    runId?: string,
  ): Promise<Result<SessionResult>> {
    const result = await this.adapter.spawn(def, prompt, adapterOptions);
    this.recordResultCost(
      result,
      type,
      costAttributionIssueNumbers,
      costReservation,
      runWriter,
      runId,
    );

    if (
      !result.ok &&
      result.error instanceof SessionError &&
      result.error.rateLimited
    ) {
      this.rateLimiter.reportRateLimit();
    }

    return result;
  }

  private async spawnWithProviderFallback(
    def: AgentDefinition,
    prompt: string,
    adapterOptions: AdapterSpawnOptions,
    type: SessionType,
    costAttributionIssueNumbers: number[],
    costReservation: CostReservation,
    runWriter?: RunWriter,
    runId?: string,
  ): Promise<Result<SessionResult>> {
    const attempted = new Set<string>();
    let lastError: Error | undefined;
    const tier = resolveModelTier(def);
    const binding =
      def.providerBinding ??
      (def.provider ? { preferred: def.provider } : undefined);

    while (true) {
      const resolution = this.providerRegistry.resolve(binding, tier, {
        exclude: attempted,
      });
      if (!resolution.ok) {
        if (lastError) return err(lastError);
        return err(
          new SessionError(
            `Provider resolution failed (${resolution.kind}): ${resolution.message}`,
            0,
            resolution.kind === 'provider-unavailable',
          ),
        );
      }

      const provider = resolution.provider;
      attempted.add(provider.name);
      const adapter = createProviderAdapter(provider);
      const result = await adapter.spawn(def, prompt, {
        ...adapterOptions,
        provider,
      });
      this.recordResultCost(
        result,
        type,
        costAttributionIssueNumbers,
        costReservation,
        runWriter,
        runId,
      );

      if (result.ok) {
        this.providerRegistry.reportSuccess(provider.name);
        return result;
      }

      lastError = result.error;
      this.providerRegistry.reportFailure(
        provider.name,
        classifyProviderFailure(result.error),
        {
          rateLimited:
            result.error instanceof SessionError && result.error.rateLimited,
        },
      );

      const budgetError = this.findBudgetError(
        costAttributionIssueNumbers,
        costReservation,
      );
      if (budgetError) return err(budgetError);
    }
  }

  private recordResultCost(
    result: Result<SessionResult>,
    type: SessionType,
    costAttributionIssueNumbers: number[],
    costReservation: CostReservation,
    runWriter?: RunWriter,
    runId?: string,
  ): void {
    const cost = result.ok
      ? result.value.cost
      : result.error instanceof SessionError
        ? result.error.cost
        : 0;
    if (cost > 0) {
      this.costTracker.recordReservedCost(costReservation, cost);
      if (runWriter && runId) {
        void runWriter.writeCostEvent(runId, type, cost);
      }
    }
  }

  private findBudgetError(
    issueNumbers: number[],
    costReservation: CostReservation,
  ): SessionError | undefined {
    for (const issueNumber of issueNumbers) {
      const budget = this.costTracker.checkBudget(issueNumber, undefined, {
        excludeReservation: costReservation,
      });
      if (!budget.available) return SessionError.budgetExceeded(budget.reason);
    }
    return undefined;
  }

  private async tryCaptureScopeBaseCommit(
    workspacePath: string,
  ): Promise<string | undefined> {
    try {
      return await captureScopeBaseCommit(workspacePath);
    } catch {
      return undefined;
    }
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

    const governance = await loadGovernanceContext(this.config);
    const pluginIds = context.activePlugins?.map((e) => e.id) ?? [];
    const activations = new Map(
      context.activePlugins?.map((e) => [e.id, e.activatedAt]) ?? [],
    );
    const loaded =
      pluginIds.length > 0
        ? await readPluginsForContext(pluginIds, activations)
        : [];
    const composite = buildCompositeContext(loaded, {
      governanceDocument: governance.content,
    });

    const parts: string[] = [];
    if (composite.governanceDocument) parts.push(composite.governanceDocument);
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

  getProviderRegistry(): ProviderRegistry {
    return this.providerRegistry;
  }

  /**
   * Build a `SessionResumeState` from a successful session result so later
   * phases / fix cycles can resume the same provider-native conversation.
   * Returns `undefined` when the result carries no continuation id.
   */
  toResumeState(
    runId: string,
    role: string,
    providerName: string,
    modelBinding: string,
    workspacePath: string,
    baseCommit: string,
    result: SessionResult,
  ): SessionResumeState | undefined {
    if (result.continuationId === undefined) {
      return undefined;
    }
    return {
      runId,
      role,
      providerName,
      modelBinding,
      continuationId: result.continuationId,
      workspaceIdentity: deriveWorkspaceIdentity(workspacePath, baseCommit),
      validity: 'valid',
    };
  }
}

function normalizeCostAttributionIssueNumbers(
  issueNumbers: number[] | undefined,
  fallbackIssueNumber: number,
): number[] {
  const normalized = (issueNumbers ?? [fallbackIssueNumber]).filter(
    (issueNumber) => Number.isInteger(issueNumber) && issueNumber > 0,
  );
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : [fallbackIssueNumber];
}

function resolveModelTier(def: AgentDefinition): ModelTier {
  if (def.modelTier) return def.modelTier;
  const model = def.modelOverride?.toLowerCase() ?? '';
  if (model.includes('haiku')) return 'standard-capability';
  if (
    model.includes('sonnet') ||
    model.includes('opus') ||
    model.includes('gpt-') ||
    model.includes('o3') ||
    model.includes('o4')
  ) {
    return 'higher-capability';
  }
  return 'standard-capability';
}
