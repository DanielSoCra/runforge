---
id: FUNC-AC-PIPELINE
type: functional
domain: auto-claude
status: draft
version: 2
layer: 1
---

# FUNC-AC-PIPELINE — Autonomous Pipeline Orchestration

## Problem Statement

Writing precise specifications is valuable only if those specifications get implemented, tested, delivered to a pre-production environment, and validated without requiring the Spec Author to shepherd the process. The gap between "spec written" and "feature available for pre-production review" is entirely mechanical — detecting work, routing it through phases, and managing state — yet today it requires continuous human attention.

## Definitions

**Work request** — A GitHub Issue on a monitored repository, labeled as ready for the system to pick up. The Issue body contains references to governing specifications (spec IDs). The system uses labels to track state transitions (ready → in-progress → complete or stuck). A work request is classified as either a feature request or a bug report based on its labels or content.

## Actors

- **Operator** — configures the system, monitors status, and approves production releases
- **Spec Author** — submits work requests with references to governing specifications
- **Daemon** — the background process that implements this spec: polls for work requests, drives the pipeline FSM, and dispatches workers. The dashboard (FUNC-AC-DASHBOARD) provides the Admin interface to this process.

## Behavior

**Scenario: Work request detection**
- Given a work request is available to be worked on
- When the system looks for available work
- Then it claims the request, marks it as underway, and begins processing

**Scenario: Complexity classification**
- Given a feature work request has been claimed
- When the system assesses its complexity
- Then it classifies the request as simple, standard, or complex based on estimated scope

**Scenario: Simple request routing**
- Given a work request classified as simple
- When the system selects a pipeline
- Then it uses a streamlined pipeline that skips decomposition and runs fewer review rounds

**Scenario: Standard request routing**
- Given a work request classified as standard
- When the system selects a pipeline
- Then it uses the default pipeline with full decomposition and standard review rounds

**Scenario: Complex request routing**
- Given a work request classified as complex
- When the system selects a pipeline
- Then it uses the default pipeline with additional review rounds

**Scenario: Bug routing**
- Given a bug work request
- When the system begins processing
- Then it uses a targeted fix workflow rather than the full feature workflow

**Scenario: Configurable workflow variants**
- Given an Operator has defined a custom workflow variant
- When a work request matches that variant's criteria
- Then the system uses that workflow variant instead of the default

**Scenario: Crash resumption**
- Given the system was interrupted mid-pipeline
- When it restarts
- Then it resumes from the point of interruption without repeating already completed work

**Scenario: Single instance enforcement**
- Given a system instance is already running for a project
- When a second instance attempts to start
- Then the second instance is rejected immediately

**Scenario: Completion**
- Given all pipeline phases have succeeded
- When the system finishes processing
- Then the work request is closed with a report and the Operator is notified

**Scenario: Delivery and verification**
- Given all review and validation gates have passed
- When the system delivers the implementation
- Then it prepares the work in a pre-production environment and runs post-delivery verification (see FUNC-AC-QUALITY for verification details)

**Scenario: Work request state transitions**
- Given a work request in any state
- When a state-changing event occurs
- Then the work request moves through explicit visible states for active work, completion, specification updates, or human review

**Scenario: Re-entry from stuck**
- Given a work request was halted after repeated failure
- When the Operator makes it available again
- Then the system processes it from scratch as a new work request

**Scenario: Re-entry from needs-spec-update**
- Given a work request is waiting on a specification update
- When the Spec Author updates the spec and resubmits the work
- Then the system processes it through the standard pipeline

**Scenario: Operator views system status**
- Given the system is running
- When the Operator requests status
- Then the system reports: active work requests, current phases, daily spending, and uptime

**Scenario: Operator pauses the system**
- Given the system is running
- When the Operator pauses it
- Then the system stops accepting new work requests but allows active work to complete

**Scenario: Operator resumes the system**
- Given the system is paused
- When the Operator resumes it
- Then the system begins accepting new work requests again

**Scenario: Operator retries a stuck request**
- Given a work request was halted after repeated failure
- When the Operator triggers a retry
- Then the system resets the request and processes it from scratch

**Scenario: Operator notification**
- Given the system completes, fails, or encounters a safety event during processing
- When the event occurs
- Then the Operator is notified through the notification system (see FUNC-AC-DASHBOARD, Notifications section) with relevant details

**Scenario: Production release**
- Given one or more completed work requests exist in pre-production
- When the Operator (or a schedule) triggers a release
- Then the system prepares a release with aggregated notes and waits for the Operator to approve

## Scope

This spec defines the lifecycle of a **single work request** from detection through completion. Each monitored repository runs its own pipeline instance.

For multi-issue coordination (batch planning, dependency ordering, merge sequencing, and product proposals), see FUNC-AC-COORDINATION. For multi-repository management (adding, enabling, configuring repositories), see FUNC-AC-DASHBOARD.

## Success Criteria

- Work requests progress from available to complete without human intervention
- The system survives interruptions and resumes without duplicating work
- Workflow variants are reusable and selectable rather than handled as one-off special cases
- Only one instance runs per project at any time

## Constraints

- Work requests are the only input — no interactive prompts during execution
- The system never modifies production directly — all automated delivery stops in pre-production. Production requires Operator approval.
- Workflow progression follows explicit rules, and exceptional cases are handled consistently
- Spec divergence (implementation exists but doesn't match spec) is a first-class case, not an error
- Scheduled maintenance (periodic reviews, test runs, dependency audits) is out of scope for initial delivery but may be added as a future capability
