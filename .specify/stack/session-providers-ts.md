---
id: STACK-AC-SESSION-PROVIDERS
type: stack-specific
domain: auto-claude
status: draft
version: 1
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

## Gotchas

- Do not read both legacy `adapter` and new `providers` config for the same spawn. Once providers are configured, Provider Registry is the single source of provider selection.
- Provider cooldown is health state, not global daemon state. A provider-local cooldown must not block another healthy provider from running.
- `CodexCliAdapter` must not assume Claude-style JSON output. Exit status drives success/failure, and stdout is wrapped as text unless a future Codex mode provides structured output.
- Liveness probes check reachability, not full session correctness. A binary being present does not prove credentials are valid; auth failures still degrade the provider on first real spawn.
- Cost from all provider attempts in one logical session accumulates against the same run and daily budgets. Fallback must never reset cost.
- Traceability must include every new provider registry and adapter file as soon as the implementation creates it.

## Concerns This Spec Does Not Cover

- The existing Session Runtime lifecycle, prompt rendering, cost accounting, containment enforcement, and workspace handling remain governed by STACK-AC-SESSION-RUNTIME.
- Agent tier selection strategy beyond basic model tier resolution is tracked separately from this multi-provider abstraction.
- Provider-specific pricing tables and exact token accounting for providers that do not emit usage metadata are implementation concerns for the Session Runtime cost layer.
