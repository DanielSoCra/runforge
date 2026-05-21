---
id: FUNC-AC-RECOVERABLE-FAILURE-ROUTING
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-RECOVERABLE-FAILURE-ROUTING - Recoverable Failure Routing

## Problem Statement

The system loses autonomy when infrastructure, workspace, delivery, or provider failures are collapsed into the same permanent stopped state as genuine human-required problems. Recoverable failures need typed metadata, bounded repair attempts, and visible routing distinct from failures that require Operator judgment.

## Actors

- **Operator** - reviews human-required failures and systemic repair failures
- **Control Plane** - classifies phase failures and routes repair attempts
- **Workspace layer** - repairs local workspace and source state problems
- **Agent Service** - reports session failures with structured status and safety signals

## Behavior

**Scenario: Typed failure outcome**
- Given a phase cannot complete
- When the phase reports a failure
- Then the Control Plane records a failure kind, severity, retryability, repair action, and human action requirement

**Scenario: Repairable failure**
- Given a failure is classified as repairable
- When the repair attempt count is below the configured bound
- Then the Control Plane runs the repair action and retries the phase without marking the work request permanently stuck

**Scenario: Human-required failure**
- Given a failure requires Operator judgment or confirmed containment intervention
- When the Control Plane records the failure
- Then the work request enters a human-required state with a clear explanation and no automatic retry

**Scenario: Repair exhaustion**
- Given a repairable failure recurs beyond its configured bound
- When no safe repair remains
- Then the work request escalates to human-required with the repair history attached

**Scenario: Failure visibility**
- Given a work request has a repairable failure
- When an Operator views status
- Then the state distinguishes retrying, repairing, paused, and human-required outcomes rather than showing all as stuck

**Scenario: Historical learning**
- Given a failure kind repeats across work requests
- When the repetition threshold is met
- Then the system captures the pattern as operational learning input for future prevention

## Success Criteria

- Failure records include a stable kind instead of only free-form error text
- Workspace and delivery failures can route to repair without permanent stuck labels
- Human-required states remain available for true product, safety, or governance decisions
- Repair attempts are bounded and visible
- Results records preserve failure kind and repair history for trend analysis

## Constraints

- Repair routing must be deterministic and auditable
- Confirmed containment violations must not be retried automatically
- Budget and rate-limit pauses remain pauses, not failures
- The system must not hide repeated infrastructure failures behind infinite retry loops
- Existing Operator-visible labels must remain understandable during migration
