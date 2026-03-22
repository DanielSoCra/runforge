---
id: ARCH-AC-SESSION-RUNTIME
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-SAFETY
---

# ARCH-AC-SESSION-RUNTIME — Session Runtime

## Overview

The Session Runtime manages the lifecycle, isolation, and resource constraints of all intelligent sessions in the system. It is the single gateway through which every other service spawns intelligent work. It enforces containment boundaries structurally (not behaviorally), tracks costs at both the session and daily level, manages rate limit detection and cooldown, and ensures that credentials never reach intelligent actors.

## Data Model

**AgentConfig** is a registry entry that maps a session type to its operational parameters. It contains: the session type name, the model tier (higher-capability or standard-capability), the execution mode (one-shot or agentic), a timeout duration, a budget cap in currency units, containment rules (an array of prohibited path patterns), a prompt template reference, a structured output schema reference (if applicable), and maximum turn count (for agentic sessions).

The registry contains entries for all session types: coordinator, classifier, worker, spec-compliance reviewer, quality reviewer, security reviewer, conflict resolver, bug worker, tester, diagnostician, reporter, and prompt optimizer. Each entry's parameters are tuned for its role — one-shot sessions have short timeouts and low budgets; agentic sessions have longer timeouts and higher budgets.

**SessionHandle** represents an active session. It contains: a process reference, the session type, a status (starting, running, completed, failed, timed-out, killed), a cost accumulator (tokens consumed and estimated currency cost), an activity log reference, a start timestamp, and the workspace path (if applicable).

**WorkerPool** manages concurrent session execution. It contains: a set of active SessionHandles, a concurrency limit (maximum simultaneous sessions), a stagger delay (minimum time between consecutive session starts within a batch), and rate limit state (cooldown-until timestamp, consecutive rate limit count, current backoff duration).

**CostTracker** maintains spending state. It contains: a daily total in currency units, per-run cost maps (run identifier to cumulative cost), a daily budget limit, and a reset timestamp (when the daily window rolls over).

**SecretsSnapshot** holds resolved credentials in memory. It contains: a map of secret names to resolved values, a last-known-good fallback snapshot, and a resolution timestamp. Secrets are resolved from configured credential sources on startup and on reload signals.

**WorkspacePool** manages pre-provisioned isolated environments. It contains: a set of ready environments (each pre-loaded with the project repository, dependencies, and build caches), a target pool size (how many ready environments to maintain), a provisioning status (how many are being prepared), and the environment specification (what a ready environment includes). Environments are disposable ("cattle, not pets") — on failure or completion, they are destroyed and replaced. The pool maintains a warm supply so that workspace allocation takes seconds, not minutes. Each environment has: no access to production systems, no access to real user data, and restricted external network access. The compute hosts that run the pool are dedicated resources owned by the Operator.

**ProviderAdapter** abstracts the execution substrate so the rest of the system does not depend on how sessions are physically run. Two adapter implementations exist:

- **SDK Adapter** — uses a programmatic library for session execution. Sessions are async function calls that return typed message streams. Hooks are programmatic callbacks. Subagent definitions are native objects. Requires an API key. Best for production use with high concurrency and precise cost tracking (API response headers provide exact token counts).

- **CLI Adapter** — spawns command-line processes for session execution. Sessions are operating system processes producing structured output on stdout. Hooks are configured via project-level configuration files. Subagent definitions are passed as structured data via command-line flags. Works with both API key authentication and subscription-based authentication (no API key required — uses the Operator's existing subscription). Best for subscription users with lower concurrency needs.

Both adapters expose the same interface to the Session Runtime: spawn a session by type with context variables and workspace requirements, receive a session result containing output, structured data, cost, extracted pitfall markers, and exit status. The adapter selection is a configuration choice made by the Operator.

**Subscription-specific considerations:** When using the CLI Adapter with a subscription, additional constraints apply:

- Message budget tracking uses a rolling window (e.g., 5-hour window) instead of a simple daily total, because subscription quotas reset on a rolling basis rather than at midnight.
- Concurrency limits should be lower than API-mode defaults, because subscription throughput is more constrained.
- Session reuse (resuming an existing session instead of starting fresh) is preferred where possible to conserve message quota.
- Lower-cost model tiers should be preferred for cheap sessions (classification, reporting) to conserve quota for expensive sessions (implementation, review).

**AgentDefinition** describes a session type as a self-contained agent specification. It contains: a name, a description (when this agent should be used), a system prompt (the agent's instructions), an array of allowed tools, an optional model override, a permission mode, optional hooks, an optional maximum turn count, optional skill references, and an optional workspace isolation mode. Agent definitions serve as the canonical format for all session types — they replace raw prompt templates with full agent specifications that include tools, model, containment, and behavior in a single artifact. The same agent definition works with both the SDK Adapter (as a native object) and the CLI Adapter (serialized to the CLI's agent format). Concrete serialization formats and tool names are specified at L3.

**ContainmentPolicy** defines access restrictions for sessions. It contains: an array of path patterns excluded from workspaces (holdout scenarios, methodology definitions, system state, system source), an array of path patterns blocked at the tool boundary (same paths, as defense-in-depth), content inspection rules for general-purpose operations (patterns that indicate exfiltration, out-of-scope modification, or untrusted execution), read/write classification rules (which operations are read-only vs write, affecting scrutiny level), and behavioral constraints included in session prompts (explicit prohibitions). Six layers enforce containment independently: five preventive (workspace exclusion, path blocking, content inspection, read/write classification, behavioral constraints) and one detective (post-session audit).

## API Contract

**Spawn session** — Called by all services that need intelligent work. Request: session type, context variables (a map of named text blocks to inject into the prompt template), workspace requirements (whether an isolated workspace is needed, and the base branch). Response: session result containing the session output, parsed structured data (if the session type uses a schema), cost incurred, any extracted pitfall markers, and the exit status.

The spawn operation proceeds:
1. Look up the AgentDefinition for the requested session type.
2. Check budget: query the CostTracker. If the daily total (or rolling window for subscription mode) exceeds the budget limit, reject the request and signal the Daemon Control Plane to pause.
3. Check rate limit: query the WorkerPool's rate limit state. If a cooldown is active, reject the request and signal the Daemon Control Plane to pause.
4. If the session requires a workspace: allocate an isolated environment from the Workspace Pool. Apply structural exclusions — holdout scenarios, methodology definitions, system state, and the system's own source are not present in the workspace environment. This is a structural guarantee, not a prompt instruction.
5. Apply stagger delay if other sessions started recently.
6. Resolve the AgentDefinition into a session request: combine the agent's system prompt with the caller's context variables, apply containment constraints, and select the appropriate model tier.
7. Delegate to the configured ProviderAdapter:
   - **SDK Adapter**: invoke the programmatic API with the agent definition, context, allowed tools, hooks (as callbacks), and structured output schema. Receive an async message stream.
   - **CLI Adapter**: spawn a command-line process with the prompt, tool restrictions, turn limits, structured output format, output schema (if applicable), and subagent definitions (if needed). Parse structured output from the process.
   In subscription mode, the CLI Adapter also checks the rolling message budget and may resume an existing session when possible.
8. Monitor the session: enforce the timeout (kill if exceeded), track tool call patterns for repetition detection, watch for rate limit signals, intercept oversized tool responses.
9. On completion: extract cost (from API response metadata in SDK mode, or from process metadata in CLI mode; estimate from duration if neither available). Parse structured output. Parse pitfall markers from session output. Audit for containment violations.
10. Update the CostTracker (session cost, run cost, daily or rolling total).
11. Return the session result to the caller.

**Check budget** — Called before spawning. Request: none. Response: available (with remaining budget) or exceeded.

**Check rate limit** — Called before spawning. Request: none. Response: clear or cooling-down (with time remaining).

**Report rate limit** — Called when a session encounters a rate limit signal. Request: optional retry-after duration. Effect: set cooldown-until timestamp using the provided duration or escalating backoff (increasing delays on consecutive signals, up to a configured maximum). Notify the Daemon Control Plane.

**Reload secrets** — Called on a reload signal. Request: none. Effect: re-resolve all secrets from configured credential sources. If all succeed, atomically swap the snapshot. If any fail, keep the last-known-good snapshot and log a warning. Response: success or partial-failure (with which secrets failed).

## System Boundaries

- Session Runtime OWNS: provider adapter selection, agent definitions, session lifecycle (spawn, monitor, kill), worker pool (concurrency, stagger, rate limit state), cost tracking (per-session, per-run, daily/rolling), secrets snapshot, containment enforcement (six independent layers), workspace pool, repetition detection, large response offloading, context compaction.
- Session Runtime IS CALLED BY: Daemon Control Plane (for classifier, reporter sessions), Implementation Coordinator (for coordinator, worker, conflict resolver sessions), Validation Service (for reviewer sessions), Bug Diagnosis Service (for diagnostician sessions), Knowledge Service (for prompt optimizer sessions).
- Session Runtime ABSTRACTS the execution substrate: callers spawn sessions by type and receive results. Whether the session runs via the SDK (API key) or via CLI processes (subscription) is a configuration choice invisible to callers.
- Session Runtime NEVER exposes credentials to intelligent sessions. Credentials are used only by the daemon's deterministic operations (deployment, notification, source control interaction).
- Session Runtime ENFORCES containment boundaries that no other service can override. Six independent layers apply: workspace exclusion, path blocking, content inspection, read/write classification, behavioral constraints, and post-session audit.

## Event Flows

**Session spawn flow:**
1. Caller requests a session by type, providing context variables and workspace requirements.
2. Session Runtime looks up the AgentConfig.
3. Budget check: if daily total >= limit, reject with budget-exceeded signal.
4. Rate limit check: if cooldown-until is in the future, reject with rate-limited signal.
5. Workspace creation (if needed): allocate an isolated environment from the Workspace Pool (see below). Apply structural exclusions so that prohibited paths do not exist. The environment itself is the primary safety boundary — containment layers within it are defense-in-depth.
6. Stagger: if the last session started less than the stagger delay ago, wait for the remaining interval.
7. Prompt assembly: load template, inject context variables, append containment prohibitions.
8. Process start: launch the session process in an isolated execution context with budget cap and timeout.
9. Monitoring: track elapsed time, activity, tool call patterns, and response sizes. On timeout: kill the process, return timeout status.
10. Completion: parse output, extract cost, extract pitfall markers, audit for violations.
11. Return result to caller.

**Large response offloading flow:**
1. After each tool call completes, the Session Runtime inspects the response size.
2. If the response exceeds a configurable threshold (e.g., 200,000 characters), the content is offloaded to a temporary reference location accessible to the session.
3. The response is replaced with a brief message indicating the content's location and size, so the session can selectively access portions rather than ingesting the full response.
4. This applies to all tool responses in all session types — not just test output. Any tool (artifact reading, command execution, search results) can produce oversized responses.

**Within-session repetition detection flow:**
1. During session execution, the Session Runtime tracks consecutive tool calls with identical names and parameters.
2. When the same call is made more than a configurable number of times consecutively (e.g., 5), the repetition is flagged.
3. On flag: the repeated call is blocked, and an intervention message is injected into the session context indicating the repetition and requesting a different approach.
4. This detects stuck loops within a single session — distinct from circular error detection, which operates across retries at the pipeline level.

**Rate limit detection flow:**
1. A session process reports error signals matching rate limit patterns.
2. Session Runtime sets cooldown-until using: the retry-after duration if available, otherwise escalating backoff (base delay doubled on each consecutive signal, capped at a configured maximum).
3. Increment consecutive rate limit count.
4. Notify the Daemon Control Plane (which transitions to paused state).
5. When cooldown-until passes: clear rate limit state, reset consecutive count, notify the Daemon Control Plane to resume.

**Cost tracking flow:**
1. After each session: parse token counts from session metadata. Convert to currency using the pricing table from configuration.
2. If metadata is unavailable: estimate cost = session duration multiplied by a per-model-tier rate (configurable safety floor).
3. Update: session cost on the SessionHandle, run cost on the CostTracker, daily total on the CostTracker.
4. If daily total >= budget limit: notify the Daemon Control Plane to pause.
5. Daily reset: when the current time passes the reset timestamp, zero the daily total and set a new reset timestamp.

**Secrets management flow:**
1. On startup: resolve each configured secret from configured credential sources. If any required secret is missing, refuse to start.
2. On reload signal: resolve all secrets into a new snapshot. If all succeed, atomically replace the current snapshot. If any fail, keep the current snapshot and log a warning.
3. During operation: deterministic operations (deployment commands, notification webhooks, source control interactions) read from the current snapshot. Intelligent sessions never receive any part of the snapshot.

**Containment enforcement flow (six independent layers — five preventive, one detective):**
1. Workspace exclusion: when creating a workspace, structurally exclude prohibited paths. Sessions running in the workspace cannot see these paths because they do not exist in the workspace environment.
2. Tool-level path blocking: a deterministic policy intercepts resource access requests and blocks access to prohibited path patterns. Blocked calls return an explicit denial message to the session — not a silent failure.
3. Operation content inspection: before executing general-purpose operations (commands, network requests), the system analyzes what the operation does — not just what resource it accesses. Operations that exfiltrate data to external destinations, modify resources outside project scope, or execute untrusted external instructions are blocked even if the tool itself is permitted. This is a content-based layer on top of the path-based layer.
4. Read/write classification: the system distinguishes read-only operations from write operations. Read-only operations (viewing artifacts, querying status) receive lower scrutiny. Write operations (modifying artifacts, executing commands with side effects) receive higher scrutiny. The same tool may be allowed for reading but require additional verification for writing.
5. Behavioral constraints: session prompts include explicit prohibitions against accessing holdout scenarios, modifying artifacts outside the workspace, and modifying the system's own source.
6. Post-session audit: after completion, scan the session's activity log for references to prohibited paths and suspicious operations. If a violation is detected, flag the run and notify the Daemon Control Plane (which transitions to stuck with a containment breach note).

**Context compaction flow:**
1. During long-running agentic sessions, the Session Runtime monitors context capacity usage.
2. When capacity approaches limits (configurable threshold, e.g., 80%), trigger compaction: summarize older conversation turns while preserving recent context and the current task state.
3. If the session is mid-workflow (executing tool calls), use a workflow-aware continuation prompt so the session resumes its task without losing thread.
4. Compaction uses a lower-cost model for summarization to minimize expense.

**Workspace pool management flow:**
1. On daemon startup: provision environments up to the target pool size. Each environment clones the repository, installs dependencies, and warms build caches.
2. Periodically: check pool level. If below target (environments consumed by sessions), provision replacements in the background.
3. On workspace allocation: remove a ready environment from the pool, apply branch-specific checkout and structural exclusions, return to the caller.
4. On session completion: destroy the environment (do not reuse — environments are single-use to prevent cross-session contamination).
5. On pool refresh: when the main branch advances, update the base image so newly provisioned environments start from a recent checkout.

**Orphaned process cleanup flow:**
1. Periodically (configurable interval): scan for managed sessions not associated with any active SessionHandle.
2. For each orphaned session: terminate it and log the event.

## Error Handling

**Session timeout:** Kill the session process. Return a timeout status to the caller. The caller decides whether to retry or escalate.

**Rate limit:** Enter cooldown with escalating backoff. Do not consume a retry attempt for rate-limit-induced failures. The Daemon Control Plane pauses and resumes automatically when cooldown expires.

**Budget exceeded (daily):** Notify the Daemon Control Plane to pause. All subsequent spawn requests are rejected until the budget resets or the operator intervenes.

**Budget exceeded (per-session):** The session process self-terminates when it reaches its budget cap (enforced by the session process itself as an independent circuit breaker). The Session Runtime records the cost and returns a budget-exceeded status to the caller.

**Containment breach detected in audit:** Flag the run as stuck with a containment breach note. Notify the Daemon Control Plane. This is a safety-critical event — the operator must review before the run can proceed.

**Secret resolution failure on startup:** Refuse to start. Log which secrets are missing.

**Secret resolution failure on reload:** Keep the last-known-good snapshot. Log a warning with which secrets failed. Continue operation with the previous credentials.

**Orphaned processes:** Terminate and log. No escalation needed — this is a cleanup operation.
