---
id: FUNC-AC-SAFETY
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-SAFETY — Operational Safety and Containment

## Problem Statement

An autonomous system that runs 24/7, starts autonomous work with broad project access, and makes real changes in real repositories poses significant operational risks: runaway costs, leaked credentials, corrupted state, orphaned work, and containment breaches. Safety must be structural — enforced by the system's design, not by trusting intelligent actors to follow instructions.

## Actors

- **Operator** — sets budget limits, reviews safety events, manages credentials

## Behavior

### Cost Control

**Scenario: Daily budget enforcement**
- Given the Operator has configured a daily spending limit
- When the system is about to start a new autonomous task
- Then it verifies the daily spend is within budget before proceeding — if exceeded, the system pauses and notifies the Operator

**Scenario: Per-task budget cap**
- Given an autonomous task is running
- When its spending reaches the per-task limit
- Then the task is terminated independently of the daily budget — two independent circuit breakers

**Scenario: Configurable execution substrate**
- Given the Operator configures how the system runs autonomous work
- When the system starts
- Then it uses the configured execution method — either direct programmatic control (requiring an account with usage-based billing) or process-based execution (compatible with subscription-based plans) — without affecting the behavior visible to other parts of the system

**Scenario: Subscription-aware resource management**
- Given the system is configured to use a subscription-based execution method
- When it manages concurrent work
- Then it respects the subscription's rolling usage windows and adjusts concurrency and session reuse accordingly — preferring to resume existing sessions and routing cheap tasks to lower-cost models

**Scenario: Budget reset**
- Given the daily budget has been exceeded
- When the 24-hour window resets (or the Operator intervenes)
- Then the system resumes normal operation

### Containment

**Scenario: Environment-level isolation**
- Given autonomous work needs a workspace
- When the system provisions that workspace
- Then the workspace is an isolated environment with no access to production systems, no access to real user data, and restricted external network access — making operations within the workspace safe by default

**Scenario: Protected work environment**
- Given an isolated workspace has been provisioned
- When the system prepares it for a specific task
- Then holdout scenarios, operational state, methodology definitions, and the system's own implementation are additionally excluded from what that work can access

**Scenario: Access blocking**
- Given autonomous work attempts to access a prohibited resource (holdout scenarios, methodology definitions, operational state, the system's own implementation)
- When the access request is evaluated
- Then it is blocked deterministically with an explicit denial, not a silent failure

**Scenario: Specification integrity**
- Given autonomous work is executing
- When it encounters a specification gap, ambiguity, or disagreement
- Then it never writes or modifies governing specifications — it escalates to the Spec Author or Operator instead

**Scenario: Behavioral constraints**
- Given autonomous work is started
- When the instructions are loaded
- Then they include explicit prohibitions against accessing holdout scenarios, modifying artifacts outside the assigned work, modifying the system's own implementation, and modifying governing specifications

**Scenario: Operation content inspection**
- Given autonomous work executes a general-purpose operation (e.g., running a command or making a network request)
- When the operation's content is analyzed before execution
- Then operations that exfiltrate data to external destinations, modify resources outside the project scope, or execute untrusted external instructions are blocked — even if the tool itself is permitted

**Scenario: Large response offloading**
- Given an operation produces a response that exceeds a size threshold
- When the response is returned to the autonomous work
- Then the system offloads the oversized content and provides a reference instead — preventing any single tool response from flooding the working context

**Scenario: Within-session repetition detection**
- Given autonomous work makes the same operation with the same inputs repeatedly
- When the repetition count exceeds a configured threshold
- Then the system intervenes to break the loop — the work must try a different approach rather than repeating the same action indefinitely

**Scenario: Read vs write classification**
- Given autonomous work requests an operation on a resource
- When the system evaluates the request
- Then read-only operations receive lower scrutiny than write operations — the same tool may be allowed for reading but require additional verification for writing

**Scenario: Post-task audit**
- Given an autonomous task has completed
- When the system audits the recorded activity
- Then it scans for references to prohibited resources — violations trigger immediate escalation

**Scenario: Task timeout**
- Given an autonomous task has been running longer than its configured timeout
- When the timeout is reached
- Then the task is terminated and the phase is retried or escalated

### Concurrency and Auto-Pause

**Scenario: Concurrency limit enforcement**
- Given the configured maximum number of concurrent work requests is reached
- When a new work request is detected
- Then it remains queued until an active request completes

**Scenario: Auto-pause after consecutive failures**
- Given multiple consecutive work requests have ended in "stuck" status
- When the count reaches the configured threshold
- Then the system auto-pauses and notifies the Operator

### Rate Limiting

**Scenario: Rate limit detection**
- Given the upstream provider signals rate limiting
- When the system detects this signal
- Then it enters a cooldown period rather than burning a retry attempt

**Scenario: Escalating backoff**
- Given multiple consecutive rate limit signals
- When each new signal arrives
- Then the cooldown period increases (escalating backoff) up to a configured maximum

**Scenario: Automatic resume after cooldown**
- Given the cooldown period has expired
- When the system checks rate limit status
- Then it resumes normal operation automatically

### Recovery

**Scenario: Safe state persistence**
- Given the system is recording operational state
- When it saves progress
- Then it does so safely enough that a crash during the save does not corrupt recovery state

**Scenario: Progress recovery**
- Given a long-running phase (implementation, review, testing)
- When meaningful progress is completed within the phase
- Then the system records that progress so recovery resumes near the interruption point, not from the start of the phase

**Scenario: Circular fix detection**
- Given a phase has failed and the system is about to retry
- When the error matches a previously seen error (same logical error, ignoring timestamps and resource locations)
- Then the system escalates immediately if the same error has occurred 3+ times, rather than exhausting all retry attempts

**Scenario: Graceful shutdown**
- Given the system receives a shutdown signal
- When it begins shutting down
- Then it stops accepting new work, waits for active work to complete up to a grace period, safely stops remaining work, cleans up temporary artifacts, and releases exclusive control

**Scenario: Orphaned work cleanup**
- Given the system is running its periodic maintenance
- When it checks for orphaned work
- Then it terminates any work still running without an active run

**Scenario: Survive a transient outage of an operational data dependency during startup**
- Given an operational data dependency the system reads while starting is temporarily unavailable
- When the system is starting up
- Then the system tolerates the outage for a bounded recovery window, makes its degraded startup state observable, refuses operations that depend on configuration not yet loaded, and resumes normal operation once the dependency returns — without requiring an Operator to restart the process

**Scenario: Underlying cause of an operational data dependency failure is observable**
- Given an operation against an operational data dependency has failed
- When the failure is recorded or surfaced
- Then the record names the underlying reason in operator-readable form, distinguishing categories the Operator must respond to differently (for example: dependency unreachable, denied access, mismatched stored shape)

**Scenario: Repeated unrecovered startup degradation is escalated**
- Given the system has remained in startup-degraded state for as many consecutive recovery attempts as the existing consecutive-failure escalation threshold
- When that threshold is reached
- Then the system notifies the Operator once on the configured channel rather than continuing silently, and does not re-notify until the degraded state has cleared at least once

### Secrets

**Scenario: Startup credential resolution**
- Given the system is starting up
- When it resolves credentials from environment and configuration
- Then all required credentials must be present — missing credentials prevent startup

**Scenario: Atomic credential reload**
- Given the system receives a reload signal
- When it re-resolves credentials
- Then it applies all-or-nothing: if all succeed, the snapshot is swapped atomically; if any fail, the previous snapshot is kept

**Scenario: Credential isolation from intelligent actors**
- Given credentials are needed for deterministic operations (deploy, notify, source control)
- When the system uses them
- Then they are never passed to autonomous tasks — only the system's trusted operational steps use credentials

## Success Criteria

- The system operates unattended overnight without exceeding budget, leaking credentials, or leaving orphaned work
- Safety enforcement is structural, not instruction-only
- State survives crashes without corruption
- Identical repeated failures are detected and escalated, not retried endlessly
- A transient outage of an operational data dependency during startup is observable, bounded, and self-recovering; an unrecovered startup outage is escalated to the Operator rather than left silent
- Every operational data dependency failure record carries an Operator-readable underlying reason and a category distinct enough to choose a different response
- While the system is in startup-degraded state, operations that depend on configuration not yet loaded are refused rather than served against defaults

## Constraints

- Containment must not depend on trusting intelligent actors to follow instructions — structural enforcement is required
- Cost control must have at least two independent mechanisms (daily budget + per-task cap)
- The system must survive overnight unattended operation for normal conditions
- Credential management follows the principle: deterministic operations use credentials, intelligent operations do not
