---
id: ARCH-AC-CONTROL-PLANE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-PIPELINE
---

# ARCH-AC-CONTROL-PLANE — Daemon Control Plane

## Overview

The Daemon Control Plane is the always-on orchestrator that owns the pipeline lifecycle. It polls for work requests, claims them, classifies their complexity, selects the appropriate pipeline variant, and drives execution through an FSM-based state machine. It manages instance locking, operator commands, crash resumption, notification dispatch, and release preparation.

## Data Model

**RunState** represents a single pipeline execution. It contains: the work request identifier (issue number), the current phase name, a map of phase names to their completion status, an array of sub-phase checkpoints (each with a phase name and a position marker), cumulative cost in currency units, an array of fix attempts (each with a phase name, attempt number, and error hash), a map of error hashes to occurrence counts for circular fix detection, and timestamps for start and last update.

**DaemonState** represents the daemon's global status. It contains: process identifier, uptime start timestamp, daily cost accumulator, daily cost reset timestamp, a paused flag, consecutive stuck count, and configuration path.

**PipelineDefinition** is a declarative description of a pipeline variant. It contains: a variant name (feature, feature-simple, or bug), an ordered list of phase names, a map of phase names to their transition rules (success target, failure target, skip target), and per-phase configuration overrides (retryable flag, max retry count). Three built-in variants exist:

- Feature: detect, classify, decompose, implement, review, holdout, integrate, deploy, test, report.
- Feature-simple: detect, classify, implement, review, holdout, integrate, deploy, test, report (skips decompose).
- Bug: detect, implement, review, integrate, deploy, test, report (skips classify, decompose, holdout).

Any phase can transition to "stuck" (retries exhausted or circular fix detected) or "paused" (budget exceeded, rate limited, or operator signal). Paused resumes from the current phase.

**ResultsRecord** is an append-only entry written at pipeline completion. It contains: issue number, start timestamp, completion timestamp, pipeline variant, complexity classification, total cost, phases executed, fix attempt count, holdout pass flag, and outcome (complete, stuck, or escalated).

## API Contract

The Daemon Control Plane exposes operator commands via a control interface bound to an exclusive local port.

**Status query** — Request: none. Response: list of active runs (each with issue number, current phase, cost so far), daily cost total, uptime duration, paused flag, consecutive stuck count. Status: success or unavailable.

**Health probe** — Request: none. Response: alive indicator. Status: success (healthy) or unavailable (unhealthy). Used by process supervisors.

**Pause command** — Request: none. Response: acknowledgment. Effect: sets paused flag, stops claiming new work requests, allows active runs to continue. Status: success or already-paused.

**Resume command** — Request: none. Response: acknowledgment. Effect: clears paused flag, resumes claiming work requests. Status: success or not-paused.

**Retry command** — Request: issue number. Response: acknowledgment. Effect: resets the run state for the specified issue and re-enters the pipeline from the beginning. Status: success, not-found, or not-stuck.

**Release command** — Request: none. Response: acknowledgment. Effect: triggers creation of a release proposal from the staging branch to the production branch with aggregated notes. Status: success or no-completed-work.

**Log query** — Request: issue number (optional). Response: structured log entries for the specified run, or recent daemon-level entries if no issue specified. Status: success or not-found.

## System Boundaries

- Daemon Control Plane OWNS: run state, daemon state, pipeline definitions, results ledger, instance lock, label state machine, notification dispatch.
- Daemon Control Plane CALLS: Session Runtime (to spawn classifier and reporter sessions), Implementation Coordinator (to execute decompose and implement phases), Validation Service (to execute review, holdout, deploy, and test phases), Bug Diagnosis Service (to classify bug work requests), Knowledge Service (to retrieve gotchas for context injection into classifier/reporter sessions).
- Daemon Control Plane EXPOSES: operator commands via the control interface (status, health, pause, resume, retry, release, logs).
- Daemon Control Plane READS: work request source (polling for ready-labeled items, reading request bodies).
- Daemon Control Plane WRITES: work request labels (claiming, completing, marking stuck), work request comments (reports, diagnoses), release proposals, results ledger entries.

## Event Flows

**Work detection and claiming:**
1. Cron loop polls the work request source for items labeled "ready."
2. On detection: swap label to "in-progress," parse the request body, create a RunState.
3. If the request is a bug: delegate to Bug Diagnosis Service, receive classification and pipeline variant selection, then enter the FSM.
4. If the request is a feature: spawn a classifier session via Session Runtime, receive complexity assessment (simple/standard/complex), select the corresponding pipeline variant, then enter the FSM.

**FSM phase execution (per phase):**
1. onEnter: check daily budget (pause if exceeded), check rate limit state (pause if cooling down), load phase configuration.
2. execute: delegate to the owning service for this phase. Detect and classify are owned by the control plane itself. Decompose and implement are delegated to Implementation Coordinator. Review, holdout, deploy, and test are delegated to Validation Service. Report is owned by the control plane (via Session Runtime for the reporter session).
3. onExit: record cost from the phase, save checkpoint to RunState, write RunState to persistent storage using crash-safe semantics (write to temporary location, then atomic rename).
4. On success: transition to the next phase per the pipeline definition.
5. On failure: check the error hash against the circular fix detector. If 3+ occurrences of the same logical error: transition to stuck immediately. Otherwise: retry up to the phase's max retry count, then transition to stuck.

**Stuck handling:**
1. Label the work request "stuck."
2. Write a comment with the failure context (phase, error summary, retry count).
3. Notify the operator via configured channels.
4. Record the outcome in the results ledger.

**Completion:**
1. Spawn a reporter session via Session Runtime to generate a structured report.
2. Post the report as a comment on the work request.
3. Label the work request "complete" and close it.
4. Record the outcome in the results ledger.
5. Notify the operator.

**Graceful shutdown:**
1. On shutdown signal: enter drain mode (stop claiming new work).
2. Wait for active sessions to complete, up to a configured grace period.
3. After grace period: terminate remaining sessions.
4. Clean up temporary workspaces.
5. Flush all RunState files to persistent storage.
6. Release the instance lock.

**Crash resumption:**
1. On startup: acquire instance lock (exclusive port binding). If port is in use, reject immediately.
2. Scan for RunState files with incomplete runs.
3. For each incomplete run: initialize the FSM at the saved phase and checkpoint position. Completed sub-phases are not re-executed.

## Error Handling

**Phase failure:** Retry up to the configured max attempts for that phase. Each retry re-executes from the phase start (or from the sub-phase checkpoint if available).

**Circular fix detection:** When the same logical error (normalized by stripping timestamps and resource-specific identifiers) occurs 3 or more times within a single run, transition to stuck immediately without exhausting remaining retries.

**Budget exceeded:** Pause the daemon. Notify the operator. Resume automatically when the daily budget window resets, or when the operator intervenes.

**Rate limited:** Pause with an escalating cooldown period (increasing delays on consecutive rate limit signals, up to a configured maximum). Resume automatically when the cooldown expires.

**Consecutive stuck runs:** When the configured threshold of consecutive stuck work requests is reached, auto-pause the daemon and notify the operator.

**Crash mid-write:** Atomic state writes (write-to-temporary-then-rename) prevent corruption. On restart, the last successfully written state is loaded.

**Instance conflict:** If a second instance attempts to start for the same project, it fails immediately because the port is already bound. A secondary mechanism (process identifier file) provides convenience for status queries and stale-lock detection.
