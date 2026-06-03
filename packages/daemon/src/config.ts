import { z } from 'zod';
import { isIP } from 'node:net';
import { readFile } from 'fs/promises';
import { ok, err, type Result } from './lib/result.js';
import { validateGate1Command } from './validation/gates.js';

const DirectoryScopeSchema = z.object({
  readPaths: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([]),
});

const ModelTierSchema = z.enum([
  'standard-capability',
  'higher-capability',
]);

const ProviderDefinitionSchema = z.object({
  name: z.string().min(1),
  adapterClass: z.enum(['process-based', 'programmatic-api']),
  providerKind: z.enum([
    'claude-cli',
    'codex-cli',
    'pi-cli',
  ]),
  supportedModelTiers: z.array(ModelTierSchema).min(1),
  required: z.boolean().default(false),
  cliTool: z.string().min(1).optional(),
  binaryPath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  executionFlags: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const ProvidersConfigSchema = z.object({
  defaultProvider: z.string().min(1),
  fallbackChain: z.array(z.string().min(1)).default([]),
  definitions: z.record(z.string(), ProviderDefinitionSchema),
});

const ProviderBindingSchema = z.object({
  preferred: z.string().min(1).optional(),
  fallback: z.array(z.string().min(1)).default([]),
});

// Per-agent-role model selection. Maps a resolved AgentDefinition name
// (e.g. 'worker', 'l2-designer', 'spec-implementer', 'batch-classifier') onto
// an override applied at spawn time by applyRoleModel (runtime.ts). Every field
// is optional, but at least one must be set — an empty entry is meaningless and
// is rejected so config typos surface at load. provider/providerBinding only
// take effect when config.providers is configured (multi-provider routing);
// the superRefine below fails fast if a role names a provider while providers
// is absent, because the legacy single-CliAdapter path silently ignores them.
const RoleModelSchema = z
  .object({
    provider: z.string().min(1).optional(),
    providerBinding: ProviderBindingSchema.optional(),
    model: z.string().min(1).optional(),
    modelTier: ModelTierSchema.optional(),
  })
  .refine(
    (rm) =>
      rm.provider !== undefined ||
      rm.providerBinding !== undefined ||
      rm.model !== undefined ||
      rm.modelTier !== undefined,
    { message: 'roleModels entry must set at least one field' },
  )
  .refine(
    (rm) =>
      rm.providerBinding === undefined ||
      rm.providerBinding.preferred !== undefined ||
      (rm.providerBinding.fallback?.length ?? 0) > 0,
    {
      message:
        'roleModels providerBinding must set preferred and/or a non-empty fallback',
    },
  );

const RuntimeSourceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    sourceRoot: z.string().min(1).optional(),
    expectedRef: z.string().min(1).optional(),
    requireClean: z.boolean().default(true),
    requireExpectedRef: z.boolean().default(true),
    allowSelfRepair: z.boolean().default(false),
    onUnhealthy: z.enum(['warn', 'pause', 'fail']).default('pause'),
    ignoredDirtyPaths: z
      .array(z.string().min(1))
      .default(['state/', 'workspaces/', '.claude/scheduled_tasks.lock']),
  })
  .default({
    enabled: true,
    requireClean: true,
    requireExpectedRef: true,
    allowSelfRepair: false,
    onUnhealthy: 'pause',
    ignoredDirtyPaths: ['state/', 'workspaces/', '.claude/scheduled_tasks.lock'],
  });

// Shapes used by validateRoleModelProviders. Typed structurally rather than via
// z.infer to avoid a forward reference to ConfigSchema's own inferred type from
// inside its superRefine.
type RoleModelShape = z.infer<typeof RoleModelSchema>;
interface RoleModelValidationInput {
  providers?: { definitions: Record<string, { model?: string }> };
  roleModels?: Record<string, RoleModelShape>;
}

/**
 * Cross-field validation for `roleModels`:
 *  - Every provider name referenced by a role (provider / providerBinding.preferred
 *    / providerBinding.fallback[]) must be a registered provider key.
 *  - Fail fast if any role names a provider/providerBinding while `config.providers`
 *    is undefined — the legacy single-CliAdapter path silently drops provider fields,
 *    so the role would never actually route to the intended (e.g. Codex) provider.
 *  - Reject the silent-override trap: a role that sets BOTH its own `model` AND a
 *    `provider` whose definition pins its own `model`. The adapters resolve
 *    `provider.model ?? def.modelOverride`, so the provider's model would silently
 *    win and the role's `model` would be a no-op (codex sparring flagged this).
 *    Surfacing it at config load forces an explicit choice.
 */
function validateRoleModelProviders(
  config: RoleModelValidationInput,
  ctx: z.RefinementCtx,
): void {
  const roleModels = config.roleModels;
  if (!roleModels) return;
  const names = config.providers
    ? new Set(Object.keys(config.providers.definitions))
    : undefined;

  for (const [role, rm] of Object.entries(roleModels)) {
    const refs: Array<{ name: string; path: (string | number)[] }> = [];
    if (rm.provider !== undefined) {
      refs.push({ name: rm.provider, path: ['roleModels', role, 'provider'] });
    }
    if (rm.providerBinding?.preferred !== undefined) {
      refs.push({
        name: rm.providerBinding.preferred,
        path: ['roleModels', role, 'providerBinding', 'preferred'],
      });
    }
    (rm.providerBinding?.fallback ?? []).forEach((name, index) => {
      refs.push({
        name,
        path: ['roleModels', role, 'providerBinding', 'fallback', index],
      });
    });

    if (refs.length === 0) continue;

    if (!names) {
      // Fail-fast: a role names a provider but no providers block exists.
      ctx.addIssue({
        code: 'custom',
        path: ['roleModels', role],
        message: `roleModels.${role} names a provider but config.providers is not configured — the legacy adapter cannot route it. Add a providers block.`,
      });
      continue;
    }

    for (const ref of refs) {
      if (!names.has(ref.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ref.path,
          message: `roleModels.${role} must reference a registered provider: ${ref.name}`,
        });
      }
    }

    // Silent-override trap: role pins its own `model` AND selects a provider whose
    // def also pins a `model`. The selected provider is `providerBinding.preferred`
    // when set, else the `provider` shorthand. provider.model wins in the adapter,
    // so the role's `model` would be silently ignored.
    if (rm.model !== undefined) {
      const selectedProvider = rm.providerBinding?.preferred ?? rm.provider;
      const providerDef =
        selectedProvider !== undefined
          ? config.providers?.definitions[selectedProvider]
          : undefined;
      if (providerDef?.model !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['roleModels', role, 'model'],
          message: `roleModels.${role}.model ("${rm.model}") would be ignored: provider "${selectedProvider}" pins its own model ("${providerDef.model}") which wins in the adapter. Drop one of the two.`,
        });
      }
    }
  }
}

// zod v4 requires .default() on nested objects to include explicit values
// matching the inner field defaults. Keep these in sync when changing defaults.
export const ConfigSchema = z.object({
  repo: z
    .object({
      owner: z.string().min(1),
      name: z.string().min(1),
    })
    .optional(),
  // Local path the pipeline worktrees branches off (`git worktree add` needs a
  // git repo to run from). Default = the daemon's cwd, which is the historical
  // contract (launch the daemon from inside a checkout of the target repo). Set
  // this when the cwd is NOT a target checkout (e.g. a container): the daemon
  // clones config.repo into this path on startup. See ensureWorkspaceRepo.
  workspaceRoot: z.string().optional(),
  controlPort: z.number().int().min(1024).max(65535).default(3847),
  controlHost: z
    .string()
    .refine((host) => isIP(host) === 4, {
      message: 'controlHost must be a valid IPv4 address',
    })
    .default('127.0.0.1'),
  pollIntervalMs: z.number().int().min(5000).default(30000),
  maxConcurrentRuns: z.number().int().min(1).default(1),
  classifierBatchSize: z.number().int().min(1).max(100).default(10),
  dailyBudget: z.number().positive().default(50),
  perRunBudget: z.number().positive().default(10),
  adapter: z.enum(['cli', 'sdk']).default('cli'),
  // Autonomous, externally-sandboxed execution (the container IS the sandbox).
  // When true, the CLI adapter passes --dangerously-skip-permissions so workers
  // clear the "Workspace not trusted" gate for dynamic worktree cwds. The
  // daemon's PreToolUse containment hooks still fire and can block tool calls
  // (Claude Code evaluates hooks before the permission-mode check), so this is
  // a trust bypass, NOT a containment bypass. Off by default — interactive /
  // native runs keep the normal trust + permission prompts. Can also be turned
  // on via the AUTO_CLAUDE_SKIP_PERMISSIONS=1 env (see runtime.ts).
  autonomous: z.boolean().default(false),
  providers: ProvidersConfigSchema.optional(),
  // Per-agent-role model/provider overrides, keyed by resolved AgentDefinition
  // name. Applied at spawn time by applyRoleModel (runtime.ts) onto the base def
  // — model -> modelOverride, plus modelTier/provider/providerBinding. Default
  // {} = today's behavior (no role is rerouted). See RoleModelSchema.
  roleModels: z.record(z.string(), RoleModelSchema).default({}),
  runtimeSource: RuntimeSourceConfigSchema,
  branches: z
    .object({
      staging: z.string().default('staging'),
      production: z.string().default('main'),
    })
    .default({ staging: 'staging', production: 'main' }),
  webhooks: z.array(z.string().url()).default([]),
  validation: z
    .object({
      gate1Commands: z
        .array(
          z
            .string()
            .refine(
              (cmd: string) =>
                !cmd.trim() || validateGate1Command(cmd) === null,
              { message: 'Gate1 command contains disallowed shell characters' },
            ),
        )
        .default([
          'vitest run',
          'tsc --noEmit',
          'eslint --max-warnings 0 src/',
        ]),
      maxFixCycles: z.number().int().min(1).default(3),
      // When true, gate1 treats a command that ALSO fails on the pristine base
      // checkout as pre-existing and does not block — only NEW failures block.
      // Default false = strict (first failure blocks). Enable for self-targeted
      // runs where the repo's own suite may already be red (#3). See createGate1.
      baselinePreexistingFailures: z.boolean().default(false),
      holdoutCommand: z
        .string()
        .refine(
          (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
          { message: 'Holdout command contains disallowed shell characters' },
        )
        .optional(),
      staticAnalysis: z
        .object({
          maxComplexity: z.number().int().default(15),
          maxFunctionLength: z.number().int().default(50),
          maxFileSize: z.number().int().default(500),
        })
        .default({
          maxComplexity: 15,
          maxFunctionLength: 50,
          maxFileSize: 500,
        }),
      diminishingReturns: z
        .object({
          minCycles: z.number().int().min(1).default(2),
          improvementThreshold: z.number().min(0).max(1).default(0.2),
        })
        .default({ minCycles: 2, improvementThreshold: 0.2 }),
      deployCommand: z
        .string()
        .refine(
          (cmd: string) => !cmd.trim() || validateGate1Command(cmd) === null,
          { message: 'Deploy command contains disallowed shell characters' },
        )
        .optional(),
      healthCheckUrl: z.string().url().optional(),
      healthCheckIntervalMs: z.number().int().min(1000).default(5000),
      deployTimeoutMs: z.number().int().min(5000).default(120000),
      maxDeployAttempts: z.number().int().min(1).default(2),
      testCommands: z
        .array(
          z
            .string()
            .refine(
              (cmd: string) =>
                !cmd.trim() || validateGate1Command(cmd) === null,
              { message: 'Test command contains disallowed shell characters' },
            ),
        )
        .default([]),
      maxTestFixAttempts: z.number().int().min(1).default(3),
      failureExcerptLines: z.number().int().min(10).default(50),
      proactiveIntervalMs: z.number().int().min(60000).default(1200000),
      proactiveAreas: z.array(z.string()).optional(),
      proactiveMaxConcurrent: z.number().int().min(1).default(1),
      proactiveThrottleThreshold: z.number().min(0).max(1).default(0.8),
      proactiveRecentCommits: z.number().int().min(1).default(20),
    })
    .default({
      gate1Commands: [
        'vitest run',
        'tsc --noEmit',
        'eslint --max-warnings 0 src/',
      ],
      maxFixCycles: 3,
      baselinePreexistingFailures: false,
      staticAnalysis: {
        maxComplexity: 15,
        maxFunctionLength: 50,
        maxFileSize: 500,
      },
      diminishingReturns: { minCycles: 2, improvementThreshold: 0.2 },
      healthCheckIntervalMs: 5000,
      deployTimeoutMs: 120000,
      maxDeployAttempts: 2,
      testCommands: [],
      maxTestFixAttempts: 3,
      failureExcerptLines: 50,
      proactiveIntervalMs: 1200000,
      proactiveMaxConcurrent: 1,
      proactiveThrottleThreshold: 0.8,
      proactiveRecentCommits: 20,
    }),
  diagnosis: z
    .object({
      confidenceThreshold: z.number().min(0).max(1).default(0.7),
    })
    .default({ confidenceThreshold: 0.7 }),
  warmup: z
    .object({
      threshold: z.number().int().min(1).default(10),
      regressionThreshold: z.number().int().min(1).default(3),
      samplingRate: z.number().min(0.01).max(1).default(0.1),
      minSamplingRate: z.number().min(0.01).max(1).default(0.01),
    })
    .default({
      threshold: 10,
      regressionThreshold: 3,
      samplingRate: 0.1,
      minSamplingRate: 0.01,
    }),
  // Optional per-deployment runaway envelope for the `worker` session type.
  // A watched single-issue pilot sets this to LOWER the hardcoded worker
  // defaults (maxTurns:50, timeoutMs:3h) without changing the global defaults
  // for other deployments. SessionRuntime applies these as a clamp
  // (min(config, default)): config can only tighten the envelope, never raise
  // it. Absent = no change. Worker-only by design — see runtime.ts clampWorkerCaps.
  workerCaps: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  maxConsecutiveStuck: z.number().int().min(1).default(30),
  gracePeriodMs: z.number().int().default(30000),
  maxRunsPerIssue: z.number().int().min(1).default(3),
  retryBackoffBaseMs: z.number().int().min(1000).default(60_000),
  retryBackoffMaxMs: z.number().int().min(10_000).default(1_800_000),
  governance: z
    .object({
      documentPath: z.string().min(1).default('FACTORY_RULES.md'),
      maxPrLinesChanged: z.number().int().min(1).default(2000),
    })
    .default({ documentPath: 'FACTORY_RULES.md', maxPrLinesChanged: 2000 }),
  agentScopes: z.record(z.string(), DirectoryScopeSchema).default({}),
  // Claude.ai Remote Control (interactive control-plane feature). It spawns a
  // long-lived `claude remote-control` subprocess that requires a trusted
  // workspace AND an interactive claude.ai login, and exposes no permission
  // bypass flag. Not needed for the autonomous worker loop, and in a root
  // container it crash-loops on the trust gate — so it is OFF by default and an
  // operator opts in explicitly. Can also be forced on via
  // AUTO_CLAUDE_REMOTE_CONTROL=1 (see daemon.ts).
  remoteControl: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  activePlugins: z.array(z.string()).default([]),
  knowledge: z
    .object({
      systemicProposalThreshold: z.number().int().min(1).default(3),
      systemicProposalCooldownDays: z.number().int().min(1).default(30),
      candidateTimeoutDays: z.number().int().min(1).default(14),
      prospectiveSeverityThreshold: z.number().int().min(1).default(5),
      knowledgePolicies: z
        .record(
          z.string(),
          z.object({
            promotionThreshold: z.number().int().min(1).optional(),
            promotionMaxAgeDays: z.number().min(1).optional(),
            archivalMaxAgeDays: z.number().min(0).optional(),
            archivalMinHitCount: z.number().int().min(0).optional(),
            injectionTargets: z.array(z.string()).optional(),
            sortOrder: z
              .enum(['priority_then_hits', 'recency', 'severity_then_recency'])
              .optional(),
          }),
        )
        .optional(),
    })
    .default({
      systemicProposalThreshold: 3,
      systemicProposalCooldownDays: 30,
      candidateTimeoutDays: 14,
      prospectiveSeverityThreshold: 5,
    }),
  knowledgeSync: z
    .object({
      enabled: z.boolean().default(false),
      vaultPath: z.string().min(1),
      syncIntervalMinutes: z.number().int().positive().default(60),
    })
    .optional(),
  coordination: z
    .object({
      useCoordinator: z.boolean().default(false),
      tickInterval: z.number().int().min(1000).default(5000),
      maxAgents: z.number().int().min(1).default(10),
      reviewerInterval: z.number().int().min(60000).default(3600000),
      poInterval: z.number().int().min(60000).default(3600000),
      poIdeaDebounce: z.number().int().min(10000).default(300000),
      poFindingDailyCap: z.number().int().min(1).default(5),
      plannerTimeout: z.number().int().min(10000).default(60000),
      maxAttemptsPerIssue: z.number().int().min(1).default(3),
      diskSpaceThreshold: z.number().int().min(0).default(2_000_000_000),
      gcInterval: z.number().int().min(60000).default(600000),
      conflictFileThreshold: z.number().int().min(1).default(3),
      conflictLineThreshold: z.number().int().min(1).default(100),
      mergeDependencyTimeout: z.number().int().min(60000).default(1800000),
      mergeValidationTimeout: z.number().int().min(60000).default(600000),
      mergePollInterval: z.number().int().min(1000).default(5000),
      mergePollMaxInterval: z.number().int().min(5000).default(60000),
      techLeadInterval: z.number().int().min(60000).default(7200000),
      techLeadEventDebounce: z.number().int().min(10000).default(300000),
      techLeadProposalExpiryMs: z
        .number()
        .int()
        .min(60000)
        .default(7 * 24 * 60 * 60 * 1000),
      techLeadLookbackWindowMs: z
        .number()
        .int()
        .min(60000)
        .default(48 * 60 * 60 * 1000),
      techLeadMaxEntriesPerSection: z.number().int().min(1).default(50),
      maxConsecutiveTickErrors: z.number().int().min(1).default(5),
    })
    .default({
      useCoordinator: false,
      tickInterval: 5000,
      maxAgents: 10,
      reviewerInterval: 3600000,
      poInterval: 3600000,
      poIdeaDebounce: 300000,
      poFindingDailyCap: 5,
      plannerTimeout: 60000,
      maxAttemptsPerIssue: 3,
      diskSpaceThreshold: 2_000_000_000,
      gcInterval: 600000,
      conflictFileThreshold: 3,
      conflictLineThreshold: 100,
      mergeDependencyTimeout: 1800000,
      mergeValidationTimeout: 600000,
      mergePollInterval: 5000,
      mergePollMaxInterval: 60000,
      techLeadInterval: 7200000,
      techLeadEventDebounce: 300000,
      techLeadProposalExpiryMs: 7 * 24 * 60 * 60 * 1000,
      techLeadLookbackWindowMs: 48 * 60 * 60 * 1000,
      techLeadMaxEntriesPerSection: 50,
      maxConsecutiveTickErrors: 5,
    }),
}).superRefine((config, ctx) => {
  const providers = config.providers;
  if (providers) {
    const names = new Set(Object.keys(providers.definitions));
    if (!names.has(providers.defaultProvider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'defaultProvider'],
        message: `defaultProvider must reference a registered provider: ${providers.defaultProvider}`,
      });
    }

    for (const [name, definition] of Object.entries(providers.definitions)) {
      if (definition.name !== name) {
        ctx.addIssue({
          code: 'custom',
          path: ['providers', 'definitions', name, 'name'],
          message: `provider definition name must match registry key: ${name}`,
        });
      }
    }

    providers.fallbackChain.forEach((name, index) => {
      if (!names.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['providers', 'fallbackChain', index],
          message: `fallback provider must reference a registered provider: ${name}`,
        });
      }
    });
  }

  // roleModels validation runs regardless of whether `providers` is set: the
  // fail-fast rule fires precisely when a role names a provider while
  // `providers` is absent (the legacy single-CliAdapter path silently ignores
  // provider fields, so the chosen provider would never be reached).
  validateRoleModelProviders(config, ctx);
});

export type Config = z.infer<typeof ConfigSchema>;

export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  budgetLimit: number | null;
  concurrencyLimit: number;
  activePlugins: Array<{ id: string; activatedAt: string }>;
}

export interface GlobalConfig {
  concurrencyLimit: number;
  dailyBudgetLimit: number | null;
  defaultModel: string;
}

export async function loadConfig(path: string): Promise<Result<Config>> {
  try {
    const raw = await readFile(path, 'utf-8');
    const json = JSON.parse(raw);
    const result = ConfigSchema.safeParse(json);
    if (result.success) return ok(result.data);
    return err(new Error(`Config validation failed: ${result.error.message}`));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
