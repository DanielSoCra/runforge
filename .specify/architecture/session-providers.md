---
id: ARCH-AC-SESSION-PROVIDERS
type: architecture
domain: runforge
status: draft
version: 2
layer: 2
references: FUNC-AC-SAFETY
---

# ARCH-AC-SESSION-PROVIDERS — Multi-Provider Session Execution

## Overview

ARCH-AC-SESSION-RUNTIME defines a ProviderAdapter abstraction with two implementations (programmatic-api and process-based) selected as a single system-wide configuration choice. This spec extends that concept: instead of one fixed adapter, the Operator registers N named providers, each pairing an adapter class with its configuration. The Provider Registry manages which providers are registered, tracks their health and per-provider rate limit state, and resolves the active provider for each session at spawn time. When only one provider is configured, the system behaves identically to the previous single-adapter model — multi-provider is a strict extension, not a breaking change.

A provider is a (adapter class, configuration identity) pair — for example, a programmatic-api adapter targeting one AI model API, or a process-based adapter targeting an external coding agent CLI. Each session type can declare a preferred provider and an ordered fallback chain; the registry resolves the active provider at spawn time and classifies provider failures to determine whether to retry on the same provider or advance to the next in the chain. The Operator configures which providers are enabled; the rest of the system selects sessions by type and remains unaware of which provider executed them.

Version 2 widens the adapter surface from spawn-only to the full runtime contract of FUNC-AC-RUNTIME-ADAPTERS — spawn, resume, abort, cost extraction, and exit-status reporting — and adds three mechanisms: durable per-run session resumption with fail-safe fresh-start fallback; a mandatory adapter smoke test (a proving run) before a provider or newly routed capability enters rotation; and a per-provider containment capability profile from which the Session Runtime composes the compensating safety baseline for providers without native guard-hook integration.

## Data Model

**ProviderDefinition** is a named, configured execution provider. It contains: a unique provider name, an adapter class (programmatic-api or process-based), provider-specific parameters (for process-based: the CLI tool name, binary location, and execution flags; for programmatic-api: the API endpoint and credentials reference name), and a set of supported model tiers (the set of model tier identifiers — e.g., higher-capability, standard-capability — that this provider can fulfill). Provider names are arbitrary identifiers chosen by the Operator in configuration (e.g., "primary-api", "secondary-cli", "fallback-cli") — the system places no constraint on naming.

Model tier and provider selection are orthogonal: model tier describes the capability level required by a session type; provider selection describes which execution substrate delivers it. Tier identifiers name required capability classes, not concrete models: structured, checklist-shaped work (classification, compliance verification, reporting) is served by lower-capability tiers, while adversarial quality and security review requires the strongest available tier. Which tier each session type requires, and which concrete model serves a tier on a given provider, are configuration — the config pack's role routing and model ladder — never fixed in platform code. The objective these mappings serve is **intelligence-fit** (FUNC-AC-FLEET v2.1): each session type runs on the minimal capability tier that sustains its lane's quality bar. Routing exists to right-size capability per task class, not to minimize raw cost; persistent under-fit (rework, review rejections) or over-fit (frontier capability on checklist work) is a configuration signal surfaced by the fit telemetry (ARCH-AC-WINDOW-SCHEDULER), never something the platform silently self-corrects. When the Session Runtime resolves a provider for a session, it filters out providers that do not list the session type's required model tier in their supported tiers. If no provider in the resolution chain supports the required tier, resolution fails with a configuration error.

Credentials referenced in a ProviderDefinition (the credentials reference name for programmatic-api adapters; environment variable names for process-based adapters) are resolved through the Session Runtime's SecretsSnapshot at startup and on reload, following the same lifecycle defined in ARCH-AC-SESSION-RUNTIME. Providers with unresolvable required credentials are treated as unavailable at startup; if a required provider fails credential resolution, daemon startup is aborted.

**ProviderRegistry** is the runtime registry of all enabled providers. It contains: a map of provider names to ProviderDefinitions, the configured default provider name (used when no binding is specified on an AgentDefinition), and a global fallback chain (ordered list of provider names tried in sequence when the preferred provider is unavailable). The registry is populated from system configuration at daemon startup and is immutable at runtime; a configuration change requires a daemon restart.

**ProviderBinding** associates a session type with its provider preferences. It contains: an optional preferred provider name (if absent, the registry default applies) and an optional ordered fallback list (if absent, the global fallback chain applies). ProviderBinding is an optional extension to AgentDefinition — session types that omit it inherit the global default and fallback chain.

**ProviderFailureClass** classifies why a provider attempt failed:
- **Transient** — rate limit signal, temporary network failure, process-level timeout. Eligible for retry on the same provider (up to the configured transient retry limit) before advancing to the fallback chain. Transient failures do not affect provider degradation state.
- **Terminal** — missing or mis-configured binary, authentication failure, invalid configuration, non-recoverable process exit. The provider is immediately marked degraded; no retry on the same provider is attempted.

**AdapterContract** is the uniform surface every adapter class implements, in the system's own terms: **spawn** (start a session from a prompt and context, returning a session result), **resume** (continue a previously persisted session where it left off, returning a session result), **abort** (stop a running session at the earliest safe point), **cost extraction** (return the session's cost, exact when the provider reports it, otherwise a conservative estimate explicitly marked as estimated), and **exit status** (a definite outcome — completed, failed, aborted, or timed out — never inferred from silence). A provider whose runtime cannot support abort cannot be registered. A provider whose runtime cannot support resume declares so in its capability profile and is always served fresh spawns.

**SessionResumeState** is the durable record that makes resumption possible across phases, fix cycles, and daemon restarts. One record exists per (run, session role, provider) and contains: the provider's opaque continuation identifier, the provider name and model binding it was created under, the identity of the workspace the session ran in, a created/last-used timestamp, and a validity marker (valid, invalidated-workspace-changed, invalidated-poisoned, invalidated-lost). It is persisted in the run's durable state in the Database, never only in process memory. A resume is attempted only when a record is valid, names the same provider and model binding, and its workspace identity matches the current workspace; any mismatch or doubt invalidates the record and forces a fresh spawn, with the reason recorded.

**ContainmentCapabilityProfile** declares, per provider, which native containment integrations its runtime supports — at minimum: native guard hooks (yes/no), structured output (yes/no), exact cost reporting (yes/no), session continuation (yes/no). The Session Runtime composes controls from this profile: a provider without native guard hooks is only ever given sessions that run inside an isolated workspace, its outputs always pass the deterministic gates, and its changes are marked so the merge decision requires independent review at the system's strongest review level before any merge eligibility. The profile can only add compensating controls relative to the native baseline, never remove any.

**SmokeProof** records a provider's proving run: the provider name, the model binding exercised, the prompt class used, whether a response was received from the routed capability, whether an observable output change was produced, a pass/fail verdict, and a timestamp. A provider (or a provider+model binding) without a current passing SmokeProof is excluded from resolution for real work. Proofs are invalidated when the provider's configuration or model binding changes.

**ProviderHealthState** tracks the liveness of each registered provider. It contains: a degradation status (available, degraded, unavailable), a consecutive terminal-failure count, a last-checked timestamp, a next-probe timestamp, a per-provider cooldown-until timestamp, and a consecutive transient-failure count. The cooldown-until timestamp replaces the global cooldown-until on the Session Runtime's WorkerPool for rate-limit scenarios: when provider A is rate-limited, only provider A enters cooldown — other providers remain available and can serve sessions immediately. The Session Runtime consults health state before delegating to a provider and skips degraded or unavailable providers during resolution.

## API Contract

The Provider Registry exposes the following operations to the Session Runtime.

**Resolve active provider** — Called at session spawn time. Request: the session type name, its ProviderBinding (may be absent), and the required model tier from the AgentDefinition. Response: the resolved ProviderDefinition to use for this spawn, or an error if resolution fails. Resolution order: preferred provider (if healthy and supports the required model tier) → fallback list entries in order (skipping degraded, on cooldown, or tier-incompatible) → global fallback chain (skipping degraded, on cooldown, or tier-incompatible) → provider-unavailable error. If every candidate in the chain is healthy but none supports the required tier, the response is a configuration error (distinct from provider-unavailable, which means all candidates are degraded or on cooldown).

**Report provider outcome** — Called after each session attempt completes or fails. Request: provider name, success or failure indicator, ProviderFailureClass (on failure), optional retry-after duration (on rate-limit transient failure). Effect:
- On transient failure: increment the transient count for this provider; if the failure includes a rate-limit signal, set the provider's cooldown-until using the retry-after duration if provided, otherwise apply escalating backoff (doubling on each consecutive rate-limit signal, capped at a configured maximum). The provider's degradation status is not changed.
- On terminal failure: transition the provider to degraded, reset the transient count, and emit a health event.
- On success: reset the transient count and clear the cooldown-until for this provider.

**Resolve session continuation** — Called by the Session Runtime before spawning work for a run that has prior phases. Request: run identifier, session role, the resolved provider, the current workspace identity. Response: resume (with the continuation identifier) when a valid SessionResumeState matches provider, model binding, and workspace identity; otherwise fresh-start with the decisive reason (no-record, workspace-changed, poisoned, provider-changed, record-lost). The response is advisory to the adapter call (resume vs spawn) and is always recorded on the run.

**Invalidate session continuation** — Called when a run's workspace is recreated or moved, when a session is judged poisoned (corrupted exchange, repeated misleading output, containment flag), or when a provider's binding changes. Request: run identifier, session role scope (one role or all), reason. Effect: the matching SessionResumeState records become invalid with that reason; subsequent resolutions return fresh-start. Invalidation is idempotent.

**Execute smoke test** — Called at daemon startup for every registered provider, and on any configuration change that wires a new provider or re-points an existing one at a different model binding. Request: provider name, model binding. Effect: run a one-shot proving session through the full adapter path — the routed capability must respond and produce an observable output change in a disposable workspace. A pass records a SmokeProof and admits the provider to resolution; a fail marks the provider degraded with cause `smoke-failed`, emits a health event for the Operator, and keeps it out of resolution. The smoke test is distinct from the health probe: the probe checks reachability, the smoke test proves the routed capability actually works end to end.

**Health probe** — Triggered periodically by the Session Runtime's maintenance loop. Request: none. Effect: for each registered provider, attempt a low-cost liveness check (confirm the binary is reachable for process-based providers; confirm the API endpoint responds for programmatic-api providers). Update ProviderHealthState accordingly. A degraded provider whose probe succeeds transitions back to available. A provider whose cooldown-until has passed is eligible for re-inclusion in resolution without a probe (the next real session attempt serves as its recovery signal). Probes are asynchronous and do not block session spawn operations.

## System Boundaries

- Provider Registry OWNS: ProviderDefinitions, ProviderRegistry contents, ProviderHealthState (including per-provider cooldown-until), provider resolution logic, failure classification logic.
- Provider Registry IS CONSULTED BY: Session Runtime on every session spawn and after every session outcome. The Session Runtime asks the registry which provider to use; the registry answers. The Session Runtime reports every outcome back so the registry can maintain accurate health and rate-limit state.
- Provider Registry READS: provider configuration (provider names, adapter classes, parameters, default, fallback chain) from the system configuration at startup.
- Provider Registry NEVER: manages session lifecycle, allocates workspaces, tracks session cost, holds session handles, modifies AgentDefinitions, or directly spawns sessions. Its only responsibility is provider selection and health tracking.
- Provider Registry DOES NOT own credential storage or resolution. Credential values are owned by Session Runtime's SecretsSnapshot. Provider Registry holds only reference names; Session Runtime resolves values when needed.
- Provider Registry OWNS (v2): SessionResumeState records and their validity lifecycle, ContainmentCapabilityProfiles, SmokeProof records, and the smoke-test gate on resolution. This realizes FUNC-AC-RUNTIME-ADAPTERS; the adapter contract itself (spawn/resume/abort/cost/exit status) is implemented by each adapter class and invoked by the Session Runtime.
- SessionResumeState is persisted with the run's durable state in the Database; the registry reads and writes it through the run-state persistence owned by the Daemon Control Plane, so continuation identifiers survive daemon restarts and are visible in run audit.
- The merge decision and Validation Service READ the containment marker produced from the ContainmentCapabilityProfile (which review level a change requires); they never read provider internals.
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

**Session resumption across phases:**
1. A run finishes a phase; the adapter returns the provider's continuation identifier with the session result.
2. Session Runtime writes/updates the SessionResumeState for (run, role, provider) in the run's durable state.
3. A later phase or fix cycle of the same run requests a session of the same role; the resolved provider matches the record.
4. Session Runtime calls resolve session continuation; on resume, the adapter is invoked with the continuation identifier instead of a fresh prompt-from-nothing, and the continuation is recorded on the run.
5. If the resume attempt itself fails (provider rejects or cannot find the continuation), the record is invalidated with reason `record-lost`, a fresh spawn is executed in the same call sequence, and the run proceeds — a failed resume degrades to fresh, never to a run failure.

**Forced fresh start:**
1. The run's workspace is recreated, relocated, or rebased, or the session is flagged poisoned (by audit, repetition detection, or an explicit operator/diagnostic signal).
2. Invalidate session continuation is called with the reason.
3. The next session for that run and role spawns fresh; the fresh start and its reason appear in the run's record.

**Provider proving (smoke test):**
1. At startup, and on any wiring or model-binding change, the registry executes the smoke test for each affected provider before it can serve resolution.
2. The proving session runs through the real adapter path in a disposable workspace: trivial task in, response and observable output change expected out.
3. Pass: SmokeProof recorded; provider eligible. Fail: provider degraded with `smoke-failed`, health event emitted, Operator informed; resolution skips it and the fallback chain absorbs its load.
4. A required provider failing its smoke test at startup is treated like failed startup verification: daemon startup is aborted.

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

**Resume against a changed workspace would otherwise occur:** Prevented structurally — the workspace identity check in resolve session continuation fails the match and forces fresh-start. There is no path that resumes a session against a workspace identity other than the one recorded.

**Continuation identifier lost or rejected by the provider:** Invalidate with `record-lost`, spawn fresh in the same dispatch, record the degradation. Never retry a rejected continuation identifier.

**Provider failover for a session that had a continuation:** A continuation is provider-bound; when resolution falls over to a different provider, the session starts fresh on the fallback provider and the original record stays bound to its provider (it may be resumed again if that provider returns and the workspace identity still matches).

**Cost extraction unavailable on a provider:** The adapter returns a conservative duration-based estimate explicitly marked estimated (per ARCH-AC-SESSION-RUNTIME's estimation rule); a provider returning neither cost nor enough metadata to estimate is a terminal adapter defect — the session result is still returned, the provider is degraded, and the Operator is informed.

**Smoke test passes but real work fails systematically:** The smoke test is an admission gate, not a quality guarantee; systematic real-work failure is handled by the ordinary outcome-reporting path (transient/terminal classification, degradation, fallback) and surfaces to the Operator through health events.
