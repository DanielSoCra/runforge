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

Recoverability is the narrow exception, not the default. Under uncertainty the system must behave the same way it does at the verifier gate: doubt resolves to caution. Any failure the system cannot positively recognize as a known, safe-to-retry kind is human-required and is never retried. This is a single, non-configurable fail-safe rule reused from the verifier gate, not a second, separately-tunable safety framework built around a repair classifier.

## Actors

- **Operator** - reviews and resolves every human-required failure, including all failures the system cannot recognize as a known safe-to-retry kind

## Behavior

**Scenario: Typed failure outcome**
- Given a phase cannot complete
- When the phase reports a failure
- Then the system records a failure kind, severity, retryability, repair action, and human-action requirement

**Scenario: Fail-safe default for unknown or uncertain failures**
- Given a failure that the system cannot positively recognize as a known safe-to-retry kind
- When the failure outcome is determined
- Then the work request enters a human-required state with no automatic retry, regardless of any later configuration or runtime adjustment

**Scenario: Bounded auto-retry only for an allowed safe-to-retry kind**
- Given a failure is recognized as one of an explicit, named set of safe-to-retry infrastructure or workspace kinds whose repair leaves the work request's prior state and evidence intact
- And the repair attempt count is below its bound
- When the system retries
- Then it runs only a repair action that does not mutate or discard prior work, generated output, source state, or other evidence an Operator would need, without marking the work request permanently stuck

**Scenario: Human-required failure**
- Given a failure that is not an allowed safe-to-retry kind, or that requires Operator judgment, or is a confirmed containment violation, or has produced a partial released or externally visible effect, or conflicts with a spec or governance rule
- When the failure outcome is determined
- Then the work request enters a human-required state with a clear explanation and no automatic retry

**Scenario: Repair exhaustion**
- Given an allowed safe-to-retry failure recurs beyond its bound
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
- Any failure not positively recognized as an allowed safe-to-retry kind is human-required and never auto-retried
- Auto-retry only ever runs on failures whose repair preserves prior work, output, source state, and other evidence intact
- Human-required states always cover unknown or uncertain failures, partial released or externally visible effects, spec or governance conflicts, and confirmed containment violations
- Workspace and delivery failures route to repair without permanent stuck labels only when they are an allowed safe-to-retry kind
- Repair attempts are bounded and visible
- Results records preserve failure kind and repair history for trend analysis

## Constraints

- Repair routing must be deterministic and auditable
- The fail-safe rule for unknown or uncertain failures is non-configurable and fail-closed: configuration, runtime adjustment, or warmup may only narrow what is auto-retried, never widen it or relabel a human-required failure as retryable
- The set of allowed safe-to-retry kinds is a narrow, named allow-list defined at a lower spec layer, must contain only non-mutating evidence-preserving kinds, and is not the safety boundary that decides whether an unknown failure is human-required
- Confirmed containment violations, partial released or externally visible effects, and spec or governance conflicts must never be retried automatically
- Budget and rate-limit pauses remain pauses, not failures
- The system must not hide repeated infrastructure failures behind infinite retry loops
- Existing Operator-visible labels must remain understandable during migration
