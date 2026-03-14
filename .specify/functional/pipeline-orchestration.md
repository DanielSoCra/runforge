---
id: FUNC-AC-PIPELINE
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-PIPELINE — Autonomous Pipeline Orchestration

## Problem Statement

Writing precise specifications is valuable only if those specifications get implemented, tested, deployed, and validated without requiring the Spec Author to shepherd the process. The gap between "spec written" and "feature live on staging" is entirely mechanical — detecting work, routing it through phases, and managing state — yet today it requires continuous human attention.

## Actors

- **Operator** — configures the system, defines pipeline templates, monitors status, approves production releases
- **Spec Author** — creates work requests with references to governing specifications

## Behavior

**Scenario: Work request detection**
- Given a work request labeled "ready" exists
- When the system polls for available work
- Then it claims the request, transitions its label to "in progress", and begins processing

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
- Then it skips classification and holdout validation, using a targeted fix workflow instead

**Scenario: Configurable pipeline templates**
- Given an Operator has defined a custom pipeline template
- When a work request matches that template's criteria
- Then the system uses the custom phase sequence instead of the default

**Scenario: Crash resumption**
- Given the system was interrupted mid-pipeline
- When it restarts
- Then it resumes from the point of interruption within the phase — if three of five units were completed, only the remaining units run, not all five

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
- Then it integrates the work into the staging branch, deploys, and runs post-deployment verification (see FUNC-AC-QUALITY for verification details)

**Scenario: Work request state transitions**
- Given a work request in any state
- When a state-changing event occurs
- Then the work request follows one of these paths: ready → in-progress → complete (success), ready → in-progress → stuck (retries exhausted), in-progress → needs-spec-update (holdout failure or spec gap), in-progress → needs-human (expectation mismatch)

**Scenario: Re-entry from stuck**
- Given a work request labeled "stuck"
- When the Operator relabels it as "ready"
- Then the system processes it from scratch as a new work request

**Scenario: Re-entry from needs-spec-update**
- Given a work request labeled "needs-spec-update"
- When the Spec Author updates the spec and relabels it as "ready"
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
- Given a work request is stuck
- When the Operator triggers a retry
- Then the system resets the request and processes it from scratch

**Scenario: Operator notification**
- Given the system completes, fails, or encounters a safety event during processing
- When the event occurs
- Then the Operator is notified through configured channels with relevant details

**Scenario: Production release**
- Given one or more completed work requests exist on staging
- When the Operator (or a schedule) triggers a release
- Then the system prepares a release with aggregated notes and waits for the Operator to approve

## Success Criteria

- Work requests progress from "ready" to "complete" without human intervention
- The system survives interruptions and resumes without duplicating work
- Pipeline templates are data (configuration), not implementation — new pipeline shapes require no implementation changes
- Only one instance runs per project at any time

## Constraints

- Work requests are the only input — no interactive prompts during execution
- The system never modifies production directly — staging only. Production requires Operator approval.
- Phase transitions are deterministic; only the work within each phase is intelligent
- Spec divergence (implementation exists but doesn't match spec) is a first-class case, not an error
- Scheduled maintenance (periodic reviews, test runs, dependency audits) is out of scope for initial delivery but may be added as a future capability
