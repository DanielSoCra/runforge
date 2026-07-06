---
id: STACK-AC-SESSION-PROVIDERS
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-SESSION-PROVIDERS
code_paths:
  - packages/daemon/src/types.ts
  - packages/daemon/src/config.ts
  - packages/daemon/src/session-runtime/runtime.ts
  - packages/daemon/src/session-runtime/providers/registry.ts
  - packages/daemon/src/session-runtime/adapters/types.ts
  - packages/daemon/src/session-runtime/adapters/index.ts
  - packages/daemon/src/session-runtime/adapters/cli.ts
  - packages/daemon/src/session-runtime/adapters/codex-cli.ts
test_paths:
  - packages/daemon/src/config.test.ts
  - packages/daemon/src/session-runtime/runtime.test.ts
  - packages/daemon/src/session-runtime/providers/registry.test.ts
  - packages/daemon/src/session-runtime/adapters/index.test.ts
  - packages/daemon/src/session-runtime/adapters/codex-cli.test.ts
---

# STACK-AC-SESSION-PROVIDERS — Multi-Provider Session Execution (TypeScript)

## Pattern

**Registry pattern for provider management.** `ProviderRegistry` is a plain class populated from daemon config at startup and immutable at runtime. A config change requires a daemon restart. Session Runtime asks the registry which provider to use; the registry returns either a resolved provider or a typed resolution error.

**Per-provider health as a keyed map.** `Map<string, ProviderHealthState>` tracks each provider independently. A rate limit on provider A sets only provider A's `cooldownUntil`; providers B and C remain eligible for new sessions.

**Resolution as a short-circuit scan.** `resolve(binding, tier)` evaluates candidates in deterministic order: preferred provider, per-binding fallback list, then global fallback list. It returns the first provider that is registered, healthy, not cooling down, and capable of the requested model tier.

**Failure classification as a pure function.** A small classifier maps session errors and process errors to `transient` or `terminal`. Transient failures can retry or fall through to fallback providers; terminal failures immediately degrade that provider.

**Process-based adapter for Codex CLI.** `CodexCliAdapter` follows the same adapter contract as the existing CLI adapter, but treats stdout as plain text and wraps it into a `SessionResult`. The adapter reads binary path, flags, and model from the selected `ProviderDefinition`; these values are never hardcoded in the adapter.

**Full adapter contract (v2).** The adapter interface widens from spawn-only to the five-operation contract of ARCH-AC-SESSION-PROVIDERS v2: `spawn`, `resume`, `abort`, plus cost and exit-status fields that every `SessionResult` must carry. Adapters that cannot resume declare it via a capability profile rather than throwing at call time.

**Resume token persisted in run state (v2).** Each adapter returns the provider-native continuation id (`session_id` for Claude CLI, the experimental resume id for Codex, the pi session id for `pi-cli`) in its `SessionResult`; the runtime stores it as a `SessionResumeState` entry on the run's durable state keyed by `(runId, role, providerName)`, with the workspace identity captured at creation. Resolution before a later spawn is a pure check: same provider, same model binding, same workspace identity, validity marker `valid` — else fresh start with a recorded reason.

**pi process adapter (v2).** `PiCliAdapter` (reserved `providerKind: 'pi-cli'`) follows the codex-cli shape: spawn the configured binary with prompt and model flags from the `ProviderDefinition`, treat exit status as the outcome authority, wrap stdout into `SessionResult`, surface the provider's continuation id for resume, and parse cost metadata when pi emits it (estimate-and-mark otherwise). pi sessions never get Claude-hook containment; the capability profile declares `nativeGuardHooks: false` so the runtime composes the compensating baseline (worktree isolation + deterministic gates + strongest-review marker).

**Adapter smoke test (v2).** A `smokeTest(provider, binding)` helper runs a one-shot trivial task through the real adapter path in a disposable workspace and asserts two things: the routed model responded (non-empty model-attributed output) and an observable output change occurred (a file artifact or structured marker). Pass admits the provider to resolution; fail degrades it with `smoke-failed`. It runs at startup and on any provider/model-binding config change, and is distinct from the reachability probe.

## Key Decisions

**Provider definitions live in daemon config.** Add a `providers` object to config with named definitions, a `defaultProvider`, and a `fallbackChain`. Each definition declares `adapterClass`, `providerKind`, supported model tiers, required/optional startup behavior, and adapter-specific settings.

```typescript
type ProviderDefinition = {
  name: string;
  adapterClass: 'process-based' | 'programmatic-api';
  providerKind: 'claude-cli' | 'codex-cli' | 'pi-cli';
  supportedModelTiers: ModelTier[];
  required?: boolean;
};
```

**Provider binding is optional on agent definitions.** Existing agents continue to use the default provider. Agents that need routing declare `providerBinding` with an optional preferred provider and fallback chain.

```typescript
type ProviderBinding = {
  preferred?: string;
  fallback?: string[];
};
```

**Model tier is separate from provider selection.** Add `modelTier` to `AgentDefinition`, defaulting from `modelOverride` when omitted. Provider resolution filters by model tier before health state, so a healthy provider that cannot serve the requested tier is not selected.

```typescript
type ModelTier = 'standard-capability' | 'higher-capability';
```

**Single-provider mode remains the default.** When no `providers` config is present, Session Runtime creates one synthetic provider from the existing adapter setting. This preserves current behavior and keeps all existing tests meaningful before multi-provider config is enabled.

**Provider resolution has two distinct failure kinds.** `configuration-error` means no candidate supports the requested tier or a binding names an unknown provider; this is permanent until config changes. `provider-unavailable` means tier-compatible providers are degraded or cooling down; this can pause and resume.

```typescript
type ResolveProviderResult =
  | { ok: true; provider: ProviderDefinition }
  | {
      ok: false;
      kind: 'configuration-error' | 'provider-unavailable';
      message: string;
    };
```

**Rate limits become provider-local in multi-provider mode.** In multi-provider mode, rate-limit signals are reported through the Provider Registry. The global rate limiter must not pause all providers when only one provider is cooling down.

**Startup validation runs after all agent definitions are known.** Validation checks that every configured provider binding references existing providers and that at least one required/default fallback provider verifies successfully. Required providers that fail verification abort startup; optional providers degrade with a warning.

**Adapter contract and resume types (v2).**

```typescript
interface ProviderAdapter {
  spawn(req: SpawnRequest): Promise<SessionResult>;
  resume(req: SpawnRequest, continuationId: string): Promise<SessionResult>;
  abort(handle: SessionHandle): Promise<void>;
  capabilities(): ContainmentCapabilityProfile;
}
```

```typescript
type SessionResumeState = {
  runId: string; role: string; providerName: string; modelBinding: string;
  continuationId: string; workspaceIdentity: string;
  validity: 'valid' | 'invalidated-workspace-changed' | 'invalidated-poisoned' | 'invalidated-lost';
};
```

## Examples

```typescript
function resolveProvider(
  binding: ProviderBinding | undefined,
  tier: ModelTier,
) {
  for (const name of buildResolutionChain(binding)) {
    const provider = providers.get(name);
    if (provider && supportsTier(provider, tier) && health.isEligible(name))
      return provider;
  }
  return unavailableOrConfigurationError(binding, tier);
}
```

```typescript
function classifyProviderFailure(error: unknown): ProviderFailureClass {
  if (isMissingBinary(error) || isAuthFailure(error) || isBadConfig(error))
    return 'terminal';
  return 'transient';
}
```

```typescript
const proc = spawn(
  def.binaryPath ?? def.cliTool,
  [...(def.executionFlags ?? []), '--model', model, prompt],
  { cwd, env: safeProviderEnv(def) },
);
```

```typescript
async function resolveContinuation(run: RunState, role: string, p: ProviderDefinition) {
  const s = run.resumeStates?.[key(run.id, role, p.name)];
  return s && s.validity === 'valid' && s.providerName === p.name
    && s.workspaceIdentity === currentWorkspaceIdentity(run)
    ? { kind: 'resume' as const, continuationId: s.continuationId }
    : { kind: 'fresh' as const, reason: freshReason(s) };
}
```

## Gotchas

- Do not read both legacy `adapter` and new `providers` config for the same spawn. Once providers are configured, Provider Registry is the single source of provider selection.
- A rejected continuation id is invalidated (`invalidated-lost`) and the dispatch falls through to a fresh spawn in the same call — never retry the same continuation id, and never fail the run on a failed resume.
- Workspace identity must change whenever the worktree is recreated, moved, or rebased onto a new base — derive it from worktree path + base commit, not path alone, or resumes will run against silently rebased ground.
- Continuations are provider-bound: on failover to another provider the session starts fresh there while the original `SessionResumeState` stays intact for its own provider.
- The smoke test must execute through the real adapter code path (same spawn arguments, same env shaping); a separate "test mode" path proves nothing about production dispatch.
- pi/codex cost fields, when absent, must produce a `costEstimated: true` result — silently recording zero cost corrupts budget enforcement and the per-lane telemetry.
- Provider cooldown is health state, not global daemon state. A provider-local cooldown must not block another healthy provider from running.
- `CodexCliAdapter` must not assume Claude-style JSON output. Exit status drives success/failure, and stdout is wrapped as text unless a future Codex mode provides structured output.
- Liveness probes check reachability, not full session correctness. A binary being present does not prove credentials are valid; auth failures still degrade the provider on first real spawn.
- Cost from all provider attempts in one logical session accumulates against the same run and daily budgets. Fallback must never reset cost.
- Traceability must include every new provider registry and adapter file as soon as the implementation creates it.

## Concerns This Spec Does Not Cover

- The existing Session Runtime lifecycle, prompt rendering, cost accounting, containment enforcement, and workspace handling remain governed by STACK-AC-SESSION-RUNTIME.
- Agent tier selection strategy beyond basic model tier resolution is tracked separately from this multi-provider abstraction. The objective tier routing serves — intelligence-fit per task class, measured by iterations-to-green and review-rejection per tier — is stated in FUNC-AC-FLEET v2.1 / ARCH-AC-WINDOW-SCHEDULER; this spec only guarantees the per-attempt cost and outcome metadata those fit metrics are computed from.
- Provider-specific pricing tables and exact token accounting for providers that do not emit usage metadata are implementation concerns for the Session Runtime cost layer.
- Which roles route to `pi-cli` (or any provider) and the fallback orders are config-pack data, never adapter code (D10).
- Capacity-pool window tracking and pool provenance are governed by ARCH-AC-WINDOW-SCHEDULER (its L3 is deferred to the implementation phase).
- Planned new files for v2 (`adapters/pi-cli.ts`, `providers/resume-state.ts`, `providers/smoke-test.ts`) are intentionally **not** listed in `code_paths` until the implementation lands them — the path-existence validator requires real files.
