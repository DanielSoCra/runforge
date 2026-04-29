---
id: ARCH-AC-SESSION-PROVIDERS
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-SAFETY
---

# ARCH-AC-SESSION-PROVIDERS — Multi-Provider Session Execution

## Overview

ARCH-AC-SESSION-RUNTIME defines a ProviderAdapter abstraction with two implementations (programmatic-api and process-based) selected as a single system-wide configuration choice. This spec extends that concept: instead of one fixed adapter, the Operator registers N named providers, each pairing an adapter class with its configuration. The Provider Registry manages which providers are registered, tracks their health and per-provider rate limit state, and resolves the active provider for each session at spawn time. When only one provider is configured, the system behaves identically to the previous single-adapter model — multi-provider is a strict extension, not a breaking change.

A provider is a (adapter class, configuration identity) pair — for example, a programmatic-api adapter targeting one AI model API, or a process-based adapter targeting an external coding agent CLI. Each session type can declare a preferred provider and an ordered fallback chain; the registry resolves the active provider at spawn time and classifies provider failures to determine whether to retry on the same provider or advance to the next in the chain. The Operator configures which providers are enabled; the rest of the system selects sessions by type and remains unaware of which provider executed them.

## Data Model

**ProviderDefinition** is a named, configured execution provider. It contains: a unique provider name, an adapter class (programmatic-api or process-based), provider-specific parameters (for process-based: the CLI tool name, binary location, and execution flags; for programmatic-api: the API endpoint and credentials reference name), and a set of supported model tiers (the set of model tier identifiers — e.g., higher-capability, standard-capability — that this provider can fulfill). Provider names are arbitrary identifiers chosen by the Operator in configuration (e.g., "primary-api", "secondary-cli", "fallback-cli") — the system places no constraint on naming.

Model tier and provider selection are orthogonal: model tier describes the capability level required by a session type; provider selection describes which execution substrate delivers it. When the Session Runtime resolves a provider for a session, it filters out providers that do not list the session type's required model tier in their supported tiers. If no provider in the resolution chain supports the required tier, resolution fails with a configuration error.

Credentials referenced in a ProviderDefinition (the credentials reference name for programmatic-api adapters; environment variable names for process-based adapters) are resolved through the Session Runtime's SecretsSnapshot at startup and on reload, following the same lifecycle defined in ARCH-AC-SESSION-RUNTIME. Providers with unresolvable required credentials are treated as unavailable at startup; if a required provider fails credential resolution, daemon startup is aborted.

**ProviderRegistry** is the runtime registry of all enabled providers. It contains: a map of provider names to ProviderDefinitions, the configured default provider name (used when no binding is specified on an AgentDefinition), and a global fallback chain (ordered list of provider names tried in sequence when the preferred provider is unavailable). The registry is populated from system configuration at daemon startup and is immutable at runtime; a configuration change requires a daemon restart.

**ProviderBinding** associates a session type with its provider preferences. It contains: an optional preferred provider name (if absent, the registry default applies) and an optional ordered fallback list (if absent, the global fallback chain applies). ProviderBinding is an optional extension to AgentDefinition — session types that omit it inherit the global default and fallback chain.

**ProviderFailureClass** classifies why a provider attempt failed:
- **Transient** — rate limit signal, temporary network failure, process-level timeout. Eligible for retry on the same provider (up to the configured transient retry limit) before advancing to the fallback chain. Transient failures do not affect provider degradation state.
- **Terminal** — missing or mis-configured binary, authentication failure, invalid configuration, non-recoverable process exit. The provider is immediately marked degraded; no retry on the same provider is attempted.

**ProviderHealthState** tracks the liveness of each registered provider. It contains: a degradation status (available, degraded, unavailable), a consecutive terminal-failure count, a last-checked timestamp, a next-probe timestamp, a per-provider cooldown-until timestamp, and a consecutive transient-failure count. The cooldown-until timestamp replaces the global cooldown-until on the Session Runtime's WorkerPool for rate-limit scenarios: when provider A is rate-limited, only provider A enters cooldown — other providers remain available and can serve sessions immediately. The Session Runtime consults health state before delegating to a provider and skips degraded or unavailable providers during resolution.

## API Contract

The Provider Registry exposes the following operations to the Session Runtime.

**Resolve active provider** — Called at session spawn time. Request: the session type name, its ProviderBinding (may be absent), and the required model tier from the AgentDefinition. Response: the resolved ProviderDefinition to use for this spawn, or an error if resolution fails. Resolution order: preferred provider (if healthy and supports the required model tier) → fallback list entries in order (skipping degraded, on cooldown, or tier-incompatible) → global fallback chain (skipping degraded, on cooldown, or tier-incompatible) → provider-unavailable error. If every candidate in the chain is healthy but none supports the required tier, the response is a configuration error (distinct from provider-unavailable, which means all candidates are degraded or on cooldown).

**Report provider outcome** — Called after each session attempt completes or fails. Request: provider name, success or failure indicator, ProviderFailureClass (on failure), optional retry-after duration (on rate-limit transient failure). Effect:
- On transient failure: increment the transient count for this provider; if the failure includes a rate-limit signal, set the provider's cooldown-until using the retry-after duration if provided, otherwise apply escalating backoff (doubling on each consecutive rate-limit signal, capped at a configured maximum). The provider's degradation status is not changed.
- On terminal failure: transition the provider to degraded, reset the transient count, and emit a health event.
- On success: reset the transient count and clear the cooldown-until for this provider.

**Health probe** — Triggered periodically by the Session Runtime's maintenance loop. Request: none. Effect: for each registered provider, attempt a low-cost liveness check (confirm the binary is reachable for process-based providers; confirm the API endpoint responds for programmatic-api providers). Update ProviderHealthState accordingly. A degraded provider whose probe succeeds transitions back to available. A provider whose cooldown-until has passed is eligible for re-inclusion in resolution without a probe (the next real session attempt serves as its recovery signal). Probes are asynchronous and do not block session spawn operations.

## System Boundaries

- Provider Registry OWNS: ProviderDefinitions, ProviderRegistry contents, ProviderHealthState (including per-provider cooldown-until), provider resolution logic, failure classification logic.
- Provider Registry IS CONSULTED BY: Session Runtime on every session spawn and after every session outcome. The Session Runtime asks the registry which provider to use; the registry answers. The Session Runtime reports every outcome back so the registry can maintain accurate health and rate-limit state.
- Provider Registry READS: provider configuration (provider names, adapter classes, parameters, default, fallback chain) from the system configuration at startup.
- Provider Registry NEVER: manages session lifecycle, allocates workspaces, tracks session cost, holds session handles, modifies AgentDefinitions, or directly spawns sessions. Its only responsibility is provider selection and health tracking.
- Provider Registry DOES NOT own credential storage or resolution. Credential values are owned by Session Runtime's SecretsSnapshot. Provider Registry holds only reference names; Session Runtime resolves values when needed.
- Session Runtime RETAINS full ownership of: cost tracking, containment enforcement, workspace management, stagger delay, session monitoring, and result parsing. The Session Runtime delegates provider selection and per-provider health/rate-limit tracking to this service; all other session management stays in Session Runtime (see ARCH-AC-SESSION-RUNTIME). The global WorkerPool cooldown-until from ARCH-AC-SESSION-RUNTIME is superseded by per-provider cooldown-until in ProviderHealthState when multiple providers are configured.

## Event Flows

**Provider resolution at spawn time:**
1. Session Runtime is asked to spawn a session of a given type.
2. Session Runtime looks up the AgentDefinition's ProviderBinding (may be absent) and the required model tier.
3. Session Runtime calls Provider Registry: resolve active provider for this binding and tier.
4. Registry evaluates candidates in resolution order, skipping providers that are degraded, whose cooldown-until is in the future, or that do not support the required model tier.
5. Registry returns the resolved ProviderDefinition, or an error (provider-unavailable or configuration error) if no candidate passes.
6. Session Runtime executes the session using the resolved adapter class and parameters.

**Transient failure and same-provider retry:**
1. Session execution fails with a transient signal (rate limit, network timeout).
2. Session Runtime reports the outcome to the Provider Registry: transient failure on provider X, with optional retry-after duration.
3. If the signal includes a rate-limit indicator: Registry sets X's cooldown-until using the retry-after duration or escalating backoff. No change to X's degradation status.
4. If the transient count for X is at or below the configured retry limit and no cooldown is set: Session Runtime retries on the same provider.
5. If X is on cooldown or the transient retry limit is exceeded: Session Runtime calls the registry to resolve the next provider, which skips X. The remaining fallback chain is evaluated. Other providers not on cooldown remain fully available.

**Terminal failure and provider fallback:**
1. Session execution fails with a terminal signal (missing binary, auth failure) or the transient retry limit is exceeded.
2. Session Runtime reports the outcome to the Provider Registry: terminal failure on provider X.
3. Registry marks X as degraded and emits a health event.
4. Session Runtime asks the registry to resolve the next provider, excluding degraded providers. The remaining fallback chain is evaluated.
5. If a healthy fallback exists: Session Runtime reattempts the session on the fallback provider. All costs from prior attempts (successful or failed) accumulate in the CostTracker; the total session and daily budgets apply across all attempts for this session type invocation.
6. If no healthy provider remains: Session Runtime returns a provider-unavailable error to its caller. The caller treats this as a transient service error and applies standard retry and pause logic.

**Background health probe:**
1. Session Runtime's maintenance loop triggers a health probe at the configured interval.
2. Registry performs a low-cost liveness check against each registered provider.
3. For each provider: if the probe succeeds and the provider was degraded, transition to available and reset the failure count. If the probe fails and the provider was available, increment the failure count; transition to degraded once the failure threshold is reached.
4. Health state updates are applied atomically; in-flight sessions are not interrupted.
5. Providers in cooldown are not probed during their cooldown window; the cooldown-until timestamp is the governing signal, not a probe result.

**Daemon startup:**
1. System configuration is read.
2. Provider Registry is populated with all ProviderDefinitions declared in configuration.
3. Each required provider is verified (binary reachable or API endpoint reachable).
4. If any required provider fails verification: daemon startup is aborted. Missing required providers are a fatal configuration error.
5. Optional providers that fail verification are marked degraded at startup with a logged warning, but do not block daemon startup. The global fallback chain must contain at least one provider that passes verification, or startup is aborted.
6. If exactly one provider is configured, the system operates with the same behavior as the previous single-adapter model. No fallback chain is evaluated; all sessions use the sole configured provider.

## Error Handling

**All providers in the chain are degraded or on cooldown:** Return provider-unavailable to the Session Runtime. The Session Runtime treats this as a pausing condition: the Daemon Control Plane is notified and pauses. The system resumes automatically when a health probe succeeds and at least one provider returns to available status, or when a per-provider cooldown-until timestamp passes.

**Configuration error — provider name in binding not present in registry:** Daemon startup is aborted. Session types must not reference provider names that are not registered. This is validated at startup, not at runtime.

**Provider transitions to degraded while sessions are in flight:** In-flight sessions are not interrupted — they run to completion or timeout on the provider they started with. The degraded status affects only new spawn attempts.

**Health probe unreachable:** Increment the failure count toward the degraded threshold. The system does not immediately mark a provider degraded on a single probe failure; the threshold provides tolerance for transient probe failures. A provider already marked degraded remains so until a probe succeeds.

**Cost accounting across provider attempts:** The Session Runtime records all session attempt costs (including attempts on degraded providers that returned partial results before failing) against the session budget, run budget, and daily total. Provider fallover does not reset cost tracking. If a fallback attempt would exceed the session budget, it is not started; the Session Runtime returns a budget-exceeded error instead.
