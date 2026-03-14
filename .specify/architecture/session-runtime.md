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

**SecretsSnapshot** holds resolved credentials in memory. It contains: a map of secret names to resolved values, a last-known-good fallback snapshot, and a resolution timestamp. Secrets are resolved from environment variables and configuration on startup and on reload signals.

**ContainmentPolicy** defines structural access restrictions for sessions. It contains: an array of path patterns excluded from workspaces (holdout scenarios, methodology definitions, system state, system source), an array of path patterns blocked at the tool boundary (same paths, as defense-in-depth), and behavioral constraints included in session prompts (explicit prohibitions). Three layers enforce the same boundaries independently.

## API Contract

**Spawn session** — Called by all services that need intelligent work. Request: session type, context variables (a map of named text blocks to inject into the prompt template), workspace requirements (whether an isolated workspace is needed, and the base branch). Response: session result containing the session output, parsed structured data (if the session type uses a schema), cost incurred, any extracted pitfall markers, and the exit status.

The spawn operation proceeds:
1. Look up the AgentConfig for the requested session type.
2. Check budget: query the CostTracker. If the daily total exceeds the budget limit, reject the request and signal the Daemon Control Plane to pause.
3. Check rate limit: query the WorkerPool's rate limit state. If a cooldown is active, reject the request and signal the Daemon Control Plane to pause.
4. If the session requires a workspace: create an isolated workspace from the specified branch. Apply structural exclusions — holdout scenarios, methodology definitions, system state, and the system's own source are not present in the workspace filesystem. This is a structural guarantee, not a prompt instruction.
5. Apply stagger delay if other sessions started recently.
6. Assemble the prompt: load the template, inject context variables, append behavioral constraints.
7. Start the session process with: the assembled prompt, the model tier, the execution mode, the budget cap, the timeout, the maximum turn count (if agentic), and the structured output schema (if applicable). Credentials are never included in the prompt or session environment.
8. Monitor the session: enforce the timeout (kill if exceeded), watch for rate limit signals in error output.
9. On completion: parse cost from session metadata (token counts converted via pricing table). If metadata is unavailable, estimate based on session duration and model tier. Parse structured output if applicable. Parse pitfall markers from session output. Scan the activity log for containment violations (references to prohibited paths).
10. Update the CostTracker (session cost, run cost, daily total).
11. Return the session result to the caller.

**Check budget** — Called before spawning. Request: none. Response: available (with remaining budget) or exceeded.

**Check rate limit** — Called before spawning. Request: none. Response: clear or cooling-down (with time remaining).

**Report rate limit** — Called when a session encounters a rate limit signal. Request: optional retry-after duration. Effect: set cooldown-until timestamp using the provided duration or escalating backoff (increasing delays on consecutive signals, up to a configured maximum). Notify the Daemon Control Plane.

**Reload secrets** — Called on a reload signal. Request: none. Effect: re-resolve all secrets from environment and configuration. If all succeed, atomically swap the snapshot. If any fail, keep the last-known-good snapshot and log a warning. Response: success or partial-failure (with which secrets failed).

## System Boundaries

- Session Runtime OWNS: session lifecycle (spawn, monitor, kill), worker pool (concurrency, stagger, rate limit state), cost tracking (per-session, per-run, daily), secrets snapshot, agent config registry, containment enforcement (workspace exclusion, tool-level blocking, behavioral constraints, post-session audit).
- Session Runtime IS CALLED BY: Daemon Control Plane (for classifier, reporter sessions), Implementation Coordinator (for coordinator, worker, conflict resolver sessions), Validation Service (for reviewer sessions), Bug Diagnosis Service (for diagnostician sessions), Knowledge Service (for prompt optimizer sessions).
- Session Runtime NEVER exposes credentials to intelligent sessions. Credentials are used only by the daemon's deterministic operations (deployment, notification, source control interaction).
- Session Runtime ENFORCES containment boundaries that no other service can override. Three independent layers apply: structural workspace exclusion, deterministic tool-level blocking, and behavioral prompt constraints.

## Event Flows

**Session spawn flow:**
1. Caller requests a session by type, providing context variables and workspace requirements.
2. Session Runtime looks up the AgentConfig.
3. Budget check: if daily total >= limit, reject with budget-exceeded signal.
4. Rate limit check: if cooldown-until is in the future, reject with rate-limited signal.
5. Workspace creation (if needed): create an isolated copy of the specified branch. Apply sparse exclusions so that prohibited paths do not exist in the workspace filesystem.
6. Stagger: if the last session started less than the stagger delay ago, wait for the remaining interval.
7. Prompt assembly: load template, inject context variables, append containment prohibitions.
8. Process start: launch the session process in an isolated execution context with budget cap and timeout.
9. Monitoring: track elapsed time and activity. On timeout: kill the process, return timeout status.
10. Completion: parse output, extract cost, extract pitfall markers, audit for violations.
11. Return result to caller.

**Rate limit detection flow:**
1. A session process reports an error matching rate limit patterns (specific exit code combined with error output containing rate limit indicators).
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
1. On startup: resolve each configured secret from environment variables. If any required secret is missing, refuse to start.
2. On reload signal: resolve all secrets into a new snapshot. If all succeed, atomically replace the current snapshot. If any fail, keep the current snapshot and log a warning.
3. During operation: deterministic operations (deployment commands, notification webhooks, source control interactions) read from the current snapshot. Intelligent sessions never receive any part of the snapshot.

**Containment enforcement flow (three independent layers):**
1. Workspace exclusion: when creating a workspace, structurally exclude prohibited paths. Sessions running in the workspace cannot see these paths because they do not exist in the workspace filesystem.
2. Tool-level blocking: a deterministic policy intercepts tool calls (file reads, file writes) and blocks access to prohibited path patterns. Blocked calls return an explicit denial message to the session — not a silent failure.
3. Behavioral constraints: session prompts include explicit prohibitions against accessing holdout scenarios, modifying artifacts outside the workspace, and modifying the system's own source.
4. Post-session audit: after completion, scan the session's activity log for references to prohibited paths. If a violation is detected, flag the run and notify the Daemon Control Plane (which transitions to stuck with a containment breach note).

**Orphaned process cleanup flow:**
1. Periodically (configurable interval): scan for child processes not associated with any active SessionHandle.
2. For each orphaned process: terminate it and log the event.

## Error Handling

**Session timeout:** Kill the session process. Return a timeout status to the caller. The caller decides whether to retry or escalate.

**Rate limit:** Enter cooldown with escalating backoff. Do not consume a retry attempt for rate-limit-induced failures. The Daemon Control Plane pauses and resumes automatically when cooldown expires.

**Budget exceeded (daily):** Notify the Daemon Control Plane to pause. All subsequent spawn requests are rejected until the budget resets or the operator intervenes.

**Budget exceeded (per-session):** The session process self-terminates when it reaches its budget cap (enforced by the session process itself as an independent circuit breaker). The Session Runtime records the cost and returns a budget-exceeded status to the caller.

**Containment breach detected in audit:** Flag the run as stuck with a containment breach note. Notify the Daemon Control Plane. This is a safety-critical event — the operator must review before the run can proceed.

**Secret resolution failure on startup:** Refuse to start. Log which secrets are missing.

**Secret resolution failure on reload:** Keep the last-known-good snapshot. Log a warning with which secrets failed. Continue operation with the previous credentials.

**Orphaned processes:** Terminate and log. No escalation needed — this is a cleanup operation.
