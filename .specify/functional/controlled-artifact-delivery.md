---
id: FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY - Controlled Artifact Delivery

## Problem Statement

Autonomous sessions produce useful artifacts, but reliability breaks down when those sessions also decide branch names, commit boundaries, review targets, labels, comments, and proposal lifecycle. Delivery decisions are system coordination concerns. They must be deterministic, traceable, and owned by the Control Plane so one work request cannot create duplicate proposals or target the wrong integration branch.

## Actors

- **Operator** - reviews proposals and approves gated work
- **Spec Author** - reviews generated specification artifacts
- **Control Plane** - owns artifact packaging, delivery records, labels, comments, and review proposals
- **Agent Service** - writes artifacts inside the assigned workspace and reports completion status

## Behavior

**Scenario: Artifact-only sessions**
- Given the Control Plane starts a design or generation session
- When the Agent Service completes
- Then the session leaves changed artifacts in the workspace and does not create delivery records, labels, comments, commits, or review proposals

**Scenario: Deterministic delivery ownership**
- Given a session has produced artifacts
- When the Control Plane packages the result
- Then it chooses the delivery identifier, target branch, source branch, commit boundary, and review proposal using configured policy

**Scenario: One proposal per issue and phase**
- Given a work request already has an open or merged proposal for a phase
- When the same phase is retried or resumed
- Then the Control Plane updates or reuses the existing proposal instead of creating a duplicate

**Scenario: Target branch safety**
- Given the Control Plane opens or updates a review proposal
- When the target branch differs from the configured staging branch
- Then delivery is rejected before the proposal becomes operator-visible

**Scenario: Durable phase artifact record**
- Given a delivery proposal is created, updated, merged, rejected, or superseded
- When the Control Plane advances or parks the run
- Then the run state records the artifact type, source branch, target branch, proposal identifier, artifact paths, status, and merge identifier if available

**Scenario: Gate resume from delivered artifact**
- Given a gated phase is approved after its proposal is merged
- When the Control Plane resumes the run
- Then subsequent phases start from the merged artifact on the staging branch, not from stale pre-merge workspace state

**Scenario: Delivery failure routing**
- Given packaging or proposal creation fails for an infrastructure reason
- When the failure is recoverable
- Then the run records a repairable delivery failure rather than marking the work request permanently stuck

## Success Criteria

- Design and generation sessions cannot directly create delivery proposals
- Review proposals are unique for each work request and phase
- Review proposals always target the configured staging branch
- Run state contains enough phase artifact metadata to resume after approval or restart
- Gate transitions reconcile against the recorded artifact before continuing

## Constraints

- Sessions may modify only artifacts inside their assigned workspace and declared scope
- The Control Plane is the only component that writes external labels, comments, delivery records, and review proposals for pipeline phases
- Delivery records must be idempotent across daemon restarts and phase retries
- Existing operator approvals must be preserved during retries
- Delivery ownership must not bypass quality, safety, or release approval gates
