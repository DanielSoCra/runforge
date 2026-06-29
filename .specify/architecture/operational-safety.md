---
id: ARCH-AC-OPERATIONAL-SAFETY
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-SAFETY
---

# ARCH-AC-OPERATIONAL-SAFETY — Operational Safety Coordination

## Overview

Operational safety is a cross-cutting concern distributed across the Session Runtime and the Daemon Control Plane. No single service owns all safety behaviors — containment and cost tracking live in the Session Runtime, while recovery, concurrency control, and lifecycle safety live in the Daemon Control Plane. This spec defines the coordination contracts, invariants, and system-level safety properties that emerge from their interaction. It does not duplicate the internal designs of those services; it defines the interfaces and guarantees they must jointly uphold.

## Data Model

Operational safety decomposes into six **SafetyDomains**, each with a primary owner and optional collaborators.

**CostControl** — Primary owner: Session Runtime. Collaborator: Daemon Control Plane. Tracks spending at three levels (per-session, per-run, daily or rolling window) and enforces independent circuit breakers. The Session Runtime is the authoritative source of spending data. The Daemon Control Plane acts on budget signals: pausing the daemon on daily budget exhaustion, transitioning individual runs to stuck on per-run budget exhaustion. The per-session budget cap enforced by the session process itself acts as a third independent limit. Budget reset (daily window expiration or operator intervention) is coordinated by the Daemon Control Plane, which resumes normal operation once the Session Runtime confirms available budget.

**Containment** — Primary owner: Session Runtime. Collaborator: none. Enforces six independent containment layers — five preventive (workspace exclusion, tool-level path blocking, operation content inspection, read/write classification, behavioral constraints) and one detective (post-session audit). Containment is structural: prohibited resources are physically absent from the workspace environment. The remaining layers are defense-in-depth. No other service can override containment policies. The Daemon Control Plane receives breach notifications and transitions affected runs to stuck, but enforcement itself is entirely within the Session Runtime.

**ConcurrencyControl** — Primary owner: Daemon Control Plane. Collaborator: Session Runtime. Two levels of concurrency operate independently. The Daemon Control Plane enforces work-request-level concurrency — how many pipeline runs execute simultaneously. The Session Runtime enforces session-level concurrency — how many intelligent sessions run simultaneously within and across runs. The Daemon Control Plane also monitors consecutive stuck runs and auto-pauses when the threshold is reached, preventing cascading failures from consuming budget on a systemic issue.

**RateLimiting** — Primary owner: Session Runtime. Collaborator: Daemon Control Plane. Detects rate limit signals from upstream providers, manages escalating backoff with configurable maximums, and signals the Daemon Control Plane to pause. The Daemon Control Plane stops claiming new work requests during cooldown. When the cooldown expires, the Session Runtime clears the state and signals the Daemon Control Plane to resume. Rate limit handling does not consume retry attempts — it is a pause, not a failure.

**Recovery** — Primary owner: Daemon Control Plane. Collaborator: Session Runtime. The Daemon Control Plane owns crash-safe state persistence (write-ahead semantics preventing corruption on crash-during-save), progress checkpointing (resuming near the interruption point, not from phase start), circular error detection (escalating after 3+ occurrences of the same logical error), graceful shutdown (drain mode, grace period, cleanup, lock release), orphaned work cleanup (periodic scan and termination of work without an active run), and **startup dependency-outage tolerance**: while the Daemon Control Plane has not yet loaded its initial configuration, the **startup-degraded flag is set** so that its observability surface (the control endpoint that answers status queries) reports degraded from the moment it accepts requests. During that window the Daemon Control Plane performs bounded inline retry with backoff against the Data Service. If a load succeeds during the inline window, the flag clears and normal operation begins without further retry. If the inline window is exhausted with *unreachable* (categorical Store outcome, see ARCH-AC-DATA-PLATFORM) outcomes, the flag remains set, work-claiming continues to be refused, and a background timer continues retrying the Data Service at the existing poll cadence; the flag clears on the first successful background load. Only retries in the **background-retry phase** (after the bounded inline window is exhausted) count against the existing consecutive-failure threshold; inline-retry attempts do not advance the counter. When that threshold is reached the Operator is notified exactly once on the configured channel, and the notification re-arms only after the degraded flag has cleared at least once. Permanent failures (a categorical *rejected* Store outcome from the Data Service, missing required credentials) are not eligible for startup-degraded mode and fail loudly on first detection. Runtime Data Service outages after first successful load are out of scope of this tolerance contract; they are handled by the existing background poll behavior (keep last-known-good config in memory and log). The Session Runtime contributes orphaned process cleanup (session processes without active handles). Both services write state safely enough that a crash during save does not corrupt recovery state.

**SecretsManagement** — Primary owner: Session Runtime. Collaborator: none. Manages startup resolution (all required credentials must be present or startup fails), atomic reload (all-or-nothing swap on reload signal, with last-known-good fallback), and credential isolation (credentials are used only by deterministic operations — deployment, notification, source control — never passed to intelligent sessions). This enforces the principle that deterministic operations use credentials, intelligent operations do not.

A **SafetyInvariant** is a system-level property that no single service guarantees alone. Four invariants hold:

- **Overnight unattended operation** — the system operates safely without human supervision because all six domains provide independent protection.
- **Structural enforcement over behavioral trust** — safety does not depend on intelligent actors following instructions. Containment is physical. Budget limits are enforced by code. Credentials are never available to sessions. Behavioral constraints are defense-in-depth, not primary enforcement.
- **Independent circuit breakers** — three independent cost limits operate simultaneously: daily budget (system-wide), per-run budget (per pipeline execution), and per-session budget (per intelligent session). The Daemon Control Plane and Session Runtime enforce different limits, so a bug in one service does not disable the other's protections.
- **Fail-safe defaults** — when safety state is ambiguous (e.g., after a crash), the system defaults to the safer option: refuse to start if credentials are missing, keep last-known-good credentials on reload failure, load the last successfully written state on crash recovery, reject spawn requests when budget status is unknown, refuse mutating operations whose required configuration has not been loaded.
- **Survivable startup outage of the Data Service** — a temporary *unreachable* Store outcome from the Data Service during startup does not terminate the Daemon Control Plane process. The process remains observable in a startup-degraded state, refuses operations that depend on the unloaded configuration, and resumes normally once the Data Service returns. A *rejected* Store outcome (versus *unreachable*) is treated as permanent and fails loudly.

## API Contract

Five cross-service contracts define the safety-critical interfaces.

**Budget signal** — Session Runtime → Daemon Control Plane: budget-exceeded signal (daily or per-run, with the run identifier and current totals). Daemon Control Plane → Session Runtime: pause directive (stop accepting new spawn requests) or resume directive (budget available again). Status: acknowledged or unreachable. Invariant: the Daemon Control Plane never spawns work that the Session Runtime would reject on budget grounds.

**Rate limit signal** — Session Runtime → Daemon Control Plane: rate-limited signal (with cooldown duration). Session Runtime → Daemon Control Plane: rate-limit-cleared signal (cooldown expired). Status: acknowledged or unreachable. Invariant: rate limit handling never consumes a retry attempt. The distinction between "paused due to rate limit" and "failed due to error" is preserved in run state.

**Containment breach signal** — Session Runtime → Daemon Control Plane: containment-breach signal (with session identifier, violation details). Status: acknowledged. Invariant: the run cannot proceed without operator review, regardless of remaining retry budget.

**Consecutive failure signal** — Daemon Control Plane internal: when the configured threshold of consecutive stuck work requests is reached, auto-pause and notify the operator. Status: paused. Invariant: the operator must intervene to resume.

**Graceful shutdown handshake** — Daemon Control Plane → Session Runtime: drain signal (stop accepting new sessions), then terminate signal (kill remaining sessions after grace period). Session Runtime → Daemon Control Plane: acknowledgment (sessions terminated, resources released). Status: drained, terminated, or timed-out. Invariant: no orphaned processes or held locks after shutdown completes within the grace period.

## System Boundaries

- Operational Safety Coordination DEFINES: cross-service safety contracts, system-level safety invariants, safety domain ownership assignments, and the L1 scenario-to-service mapping.
- Operational Safety Coordination DOES NOT OWN runtime components. It is a coordination spec — enforcement is delegated.
- Session Runtime OWNS: containment enforcement (six independent layers), cost tracking (per-session, per-run, daily or rolling), rate limit detection and cooldown, secrets lifecycle, workspace isolation, within-session repetition detection, large response offloading, and orphaned process cleanup.
- Daemon Control Plane OWNS: recovery (crash-safe persistence, progress checkpointing, circular error detection), graceful shutdown, work-request-level concurrency, consecutive-failure auto-pause, and orphaned work cleanup.
- Session Runtime SIGNALS: Daemon Control Plane (budget exceeded, rate limited, rate limit cleared, containment breach).
- Daemon Control Plane SIGNALS: Session Runtime (pause, resume, drain, terminate).
- Neither service can override the other's safety enforcement. Budget enforcement requires both services to agree: the Session Runtime is the authoritative source of spending data, and the Daemon Control Plane is the authoritative decision-maker on whether to pause or continue.
- Daemon Control Plane OWNS a **startup fail-safe (A1)**: a deployment's required dependencies must be present before it accepts work. A *merge-governed* deployment (one with a deployment profile) depends on the structured decision-escalation transport (ARCH-AC-DECISION-ESCALATION) to reach the Operator for every escalate/hold/compliance merge decision. At boot the Control Plane refuses to start such a deployment when its profile is rejected at registration, or its decision transport is unavailable — distinguishing *disabled* (set the index flag) from *enabled-but-unreachable* (the backing store is down) — and reports the underlying cause in operator-readable form. This realizes FUNC-AC-SAFETY *"missing required config prevents startup"* / *"refuses operations that depend on configuration not yet loaded"* and the L0 *"a fail-closed stop beats a fake success"*: the daemon does not start blind and silently drop required operator approvals. A non-governed deployment has no such dependency and is unaffected.

## Event Flows

**Cost control flow (spanning both services):**
1. Session Runtime completes a session and updates the cost tracker (per-session, per-run, daily or rolling total).
2. If daily total exceeds the budget limit: Session Runtime sends a budget-exceeded signal to the Daemon Control Plane.
3. Daemon Control Plane sets paused flag, stops claiming new work requests, notifies the operator.
4. When the daily window resets (or the operator intervenes): Daemon Control Plane queries the Session Runtime for current budget status.
5. Session Runtime confirms available budget. Daemon Control Plane clears paused flag and resumes.
6. Independently: if per-run cost exceeds the per-run limit, the Daemon Control Plane transitions that specific run to stuck (other runs unaffected).
7. Independently: if per-session cost exceeds the session budget cap, the session process self-terminates.

**Containment breach flow (spanning both services):**
1. Session Runtime detects a violation during post-session audit (reference to prohibited path or suspicious operation).
2. Session Runtime sends a containment-breach signal to the Daemon Control Plane with session identifier and violation details.
3. Daemon Control Plane transitions the affected run to stuck with a containment breach note.
4. Daemon Control Plane notifies the operator. The run cannot proceed without operator review.

**Rate limit flow (spanning both services):**
1. Session Runtime detects a rate limit signal from an upstream provider.
2. Session Runtime sets cooldown-until using the retry-after duration or escalating backoff (base delay doubled on each consecutive signal, capped at maximum).
3. Session Runtime sends rate-limited signal to the Daemon Control Plane.
4. Daemon Control Plane stops claiming new work requests.
5. When cooldown-until passes: Session Runtime clears rate limit state and sends rate-limit-cleared signal.
6. Daemon Control Plane resumes claiming work requests.

**Graceful shutdown flow (spanning both services):**
1. Daemon Control Plane receives a shutdown signal and enters drain mode (stops claiming new work).
2. Daemon Control Plane sends drain signal to Session Runtime (stop accepting new session spawn requests).
3. Daemon Control Plane waits for active sessions to complete, up to the configured grace period.
4. After grace period: Daemon Control Plane sends terminate signal to Session Runtime.
5. Session Runtime kills remaining session processes, releases workspace resources, acknowledges.
6. Daemon Control Plane flushes all run state to persistent storage, cleans up temporary artifacts, releases the instance lock.

**Consecutive failure flow (Daemon Control Plane internal):**
1. A work request completes with stuck status.
2. Daemon Control Plane increments the consecutive stuck count.
3. If the count reaches the configured threshold: auto-pause and notify the operator.
4. On successful completion of a work request: reset the consecutive stuck count to zero.

**L1 scenario coverage:** Every L1 scenario in FUNC-AC-SAFETY maps to one of the flows above. Cost Control scenarios (daily budget, per-task cap, execution substrate, subscription-aware management, budget reset) map to the cost control flow and Session Runtime internals. Containment scenarios (isolation, access blocking, content inspection, response offloading, repetition detection, read/write classification, audit, timeout) map to Session Runtime's six containment layers. Concurrency scenarios map to the consecutive failure flow and Daemon Control Plane internals. Rate limiting scenarios map to the rate limit flow. Recovery scenarios (state persistence, progress recovery, circular error detection, shutdown, orphaned cleanup, **startup outage tolerance and its escalation, plus underlying-cause observability for operational data dependencies**) map to the graceful shutdown flow, the Daemon Control Plane's startup read-dependency flow (below), and the Daemon Control Plane's internal counters. Secrets scenarios map to Session Runtime internals.

**Startup read-dependency outage flow (Daemon Control Plane internal):**
1. Daemon Control Plane starts the control endpoint (observability surface) first; `startupDegraded = true` is the initial flag so the observability surface reports degraded from t=0 while no configuration has yet been loaded.
2. Daemon Control Plane performs a bounded inline retry of the initial Data Service load, logging each attempt's outcome category and underlying reason. Inline-retry attempts do **not** advance the consecutive-failure counter.
3. If any inline attempt returns a *rejected* Store outcome: short-circuit; the process exits with the underlying reason surfaced. No transition into background-retry phase.
4. If a successful load occurs within the inline retry: clear `startupDegraded`; proceed to normal operation.
5. If the inline retry is exhausted with *unreachable* outcomes: keep `startupDegraded = true`; the control endpoint continues to report degraded with the last error; the work-claim loop continues to refuse claims; the daemon enters **background-retry phase** with a timer that calls the Data Service at the existing poll cadence.
6. On the first successful background load: clear `startupDegraded`; rearm the escalation notifier.
7. In background-retry phase, each unrecovered *unreachable* retry increments the consecutive-failure counter. Once the counter reaches the configured consecutive-failure threshold (the same threshold used for stuck-run auto-pause), notify the Operator once on the configured channel. Do not re-notify until the flag has cleared at least once.
8. If a background-retry attempt returns a *rejected* Store outcome at any time: the Daemon Control Plane logs the underlying reason and exits the process (mirroring the inline-phase short-circuit). The escalation counter is not consulted; a categorical *rejected* outcome is always treated as permanent regardless of which phase observed it. Restart-after-fix becomes the Operator's responsibility (launchd will respawn, but only `KeepAlive` semantics apply — the categorical *rejected* outcome will recur until the underlying schema/permission/auth issue is resolved).

## Error Handling

**Cross-service signal failure:** If the Session Runtime cannot reach the Daemon Control Plane to deliver a budget or rate limit signal, it defaults to the safe state: reject subsequent spawn requests until the signal is delivered. The Daemon Control Plane, on detecting that no signals have arrived for longer than expected, proactively queries the Session Runtime's status.

**Conflicting signals:** If the Daemon Control Plane receives both a resume and a pause signal in close succession, the pause signal takes precedence. Safety signals always win over operational signals.

**Partial shutdown:** If the grace period expires before all sessions complete, the Daemon Control Plane forcibly terminates remaining sessions. State for interrupted runs is marked as incomplete, not as successfully checkpointed, ensuring recovery does not skip partially-executed phases.

**Safety domain degradation:** If one safety domain fails (e.g., cost tracking becomes unavailable), the system does not continue operating with reduced safety. It pauses and notifies the operator. The fail-safe default is to stop, not to proceed without protection.

**Startup read-dependency outage:** When the Data Service is *unreachable* (categorical Store outcome) at startup, the Daemon Control Plane performs bounded inline retry with backoff (each attempt's outcome category and underlying reason logged), then transitions to startup-degraded state. In startup-degraded state the control endpoint reports degraded, work-claiming is refused, and the Data Service is retried in the background at the existing poll cadence. On first successful load the degraded flag is cleared and normal operation resumes without process restart. Unrecovered startup degradation that persists across the existing consecutive-failure threshold notifies the Operator exactly once on the configured channel; the notifier re-arms only after the flag has cleared. A *rejected* Store outcome (schema/permission mismatch, authentication denial) is not eligible for degraded mode; the process fails fast with the underlying reason surfaced.
