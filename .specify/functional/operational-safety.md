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

An autonomous system that runs 24/7, spawns intelligent sessions with full workspace environment access, and makes real commits to real repositories poses significant operational risks: runaway costs, leaked credentials, corrupted state, orphaned processes, and containment breaches. Safety must be structural — enforced by the system's architecture, not by trusting intelligent actors to follow instructions.

## Actors

- **Operator** — sets budget limits, reviews safety events, manages credentials
- **Worker** — any intelligent actor whose access must be constrained

## Behavior

### Cost Control

**Scenario: Daily budget enforcement**
- Given the Operator has configured a daily spending limit
- When the system is about to spawn an intelligent session
- Then it verifies the daily spend is within budget before proceeding — if exceeded, the system pauses and notifies the Operator

**Scenario: Per-session budget cap**
- Given an intelligent session is running
- When its spending reaches the per-session limit
- Then the session is terminated independently of the daily budget — two independent circuit breakers

**Scenario: Budget reset**
- Given the daily budget has been exceeded
- When the 24-hour window resets (or the Operator intervenes)
- Then the system resumes normal operation

### Containment

**Scenario: Workspace isolation**
- Given a Worker is assigned a unit of work
- When the system creates a workspace for the Worker
- Then holdout scenarios, system state, methodology definitions, and the system's own implementation are all structurally excluded from the Worker's environment — Workers cannot access them

**Scenario: Tool-level access blocking**
- Given a Worker attempts to access a prohibited resource (holdout scenarios, methodology definitions, system state, the system's own implementation)
- When the access request reaches the tool boundary
- Then it is blocked deterministically — the Worker receives an explicit denial, not a silent failure

**Scenario: Behavioral constraints**
- Given a Worker's operating instructions
- When the instructions are loaded
- Then they include explicit prohibitions against accessing holdout scenarios, modifying artifacts outside the workspace, and modifying the system's own implementation

**Scenario: Post-session audit**
- Given an intelligent session has completed
- When the system audits the activity record
- Then it scans for references to prohibited resources — violations trigger immediate escalation

**Scenario: Session timeout**
- Given an intelligent session has been running longer than its configured timeout
- When the timeout is reached
- Then the session is terminated and the phase is retried or escalated

### Concurrency and Auto-Pause

**Scenario: Concurrency limit enforcement**
- Given the configured maximum number of concurrent work requests is reached
- When a new work request is detected
- Then it remains queued until an active request completes

**Scenario: Auto-pause after consecutive failures**
- Given multiple consecutive work requests have ended in "stuck" status
- When the count exceeds the configured threshold
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

**Scenario: Atomic state persistence**
- Given the system is writing state to disk
- When it performs the write
- Then it uses crash-safe write semantics so a crash mid-write never corrupts state

**Scenario: Sub-phase checkpointing**
- Given a long-running phase (implementation, review, testing)
- When a sub-unit of work completes within the phase
- Then the system saves a checkpoint so crash recovery resumes within the phase, not at the phase boundary

**Scenario: Circular fix detection**
- Given a phase has failed and the system is about to retry
- When the error matches a previously seen error (same logical error, ignoring timestamps and resource locations)
- Then the system escalates immediately if the same error has occurred 3+ times, rather than exhausting all retry attempts

**Scenario: Graceful shutdown**
- Given the system receives a shutdown signal
- When it begins shutting down
- Then it stops accepting new work, waits for active sessions to complete (up to a grace period), terminates remaining sessions, cleans up temporary workspaces, and releases all locks

**Scenario: Orphaned process cleanup**
- Given the system is running its periodic maintenance
- When it checks for orphaned child processes
- Then it terminates any processes not associated with an active run

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
- Then they are never passed to intelligent sessions — only the system's deterministic operations use credentials

## Success Criteria

- The system operates unattended overnight without exceeding budget, leaking credentials, or leaving orphaned processes
- Safety enforcement is structural (workspace exclusion, tool-level blocking, process termination), not behavioral (prompts alone)
- State survives crashes without corruption
- Identical repeated failures are detected and escalated, not retried endlessly

## Constraints

- Containment must not depend on trusting intelligent actors to follow instructions — structural enforcement is required
- Cost control must have at least two independent mechanisms (daily budget + per-session cap)
- The system must survive overnight unattended operation for normal conditions
- Credential management follows the principle: deterministic operations use credentials, intelligent operations do not
