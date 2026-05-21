---
id: ARCH-AC-CONTROLLED-ARTIFACT-DELIVERY
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY
---

# ARCH-AC-CONTROLLED-ARTIFACT-DELIVERY - Controlled Artifact Delivery

## Overview

Controlled Artifact Delivery separates artifact authoring from artifact delivery. Agent sessions write files in a prepared workspace. The Control Plane then packages those file changes into a deterministic delivery unit, records the unit in run state, opens or updates the review proposal, and parks or advances the run according to the relevant gate.

This architecture is the delivery contract for gated specification phases and for any future phase that produces externally reviewed artifacts.

## Data Model

**PhaseArtifact** records the durable output of one pipeline phase. It contains: work request identifier, phase name, artifact kind, artifact paths, source branch, target branch, proposal identifier, status, created timestamp, updated timestamp, and optional merge identifier.

**ArtifactStatus** is one of: prepared, proposed, awaiting-review, merged, rejected, superseded, or delivery-failed.

**DeliveryPolicy** defines branch naming, target branch selection, proposal title format, proposal body format, duplicate lookup rules, and whether an existing proposal may be updated.

**DeliveryRequest** is created after an Agent Service session completes. It contains: run identifier, work request identifier, phase name, workspace path, expected artifact paths, delivery policy, and any gate feedback being addressed.

**DeliveryResult** contains: PhaseArtifact, changed artifact paths, whether an existing proposal was reused, and a failure kind when delivery cannot complete.

**ProposalKey** uniquely identifies the review proposal for a work request and phase. It is derived from the work request identifier, phase name, repository identity, and target branch.

## API Contract

**Package phase artifact** - Called by the Control Plane after a session phase succeeds. Request: DeliveryRequest. Response: DeliveryResult.

The operation:
1. Computes changed artifacts from the workspace.
2. Rejects empty output unless the phase explicitly allows no-op completion.
3. Validates that changed paths match the phase's expected artifact scope.
4. Creates or updates the phase source branch according to DeliveryPolicy.
5. Creates or updates exactly one review proposal identified by ProposalKey.
6. Records the PhaseArtifact in RunState before the run is parked or advanced.

**Reconcile phase artifact** - Called before a gated run resumes. Request: run identifier, work request identifier, and phase name. Response: the latest PhaseArtifact and whether the workspace must be recreated.

The operation:
1. Loads the recorded PhaseArtifact.
2. Checks the proposal status.
3. If merged, verifies that the merge identifier is present on the target branch.
4. Marks old workspaces obsolete when they predate the merged artifact.
5. Returns a resume base that the workspace layer can use to prepare a fresh workspace.

**Find duplicate proposal** - Called during package and repair flows. Request: ProposalKey. Response: existing proposal reference or none.

## System Boundaries

- Control Plane OWNS: DeliveryPolicy evaluation, proposal keys, phase artifact records, label and comment updates, proposal creation and update, proposal status reconciliation.
- Agent Service OWNS: artifact authoring inside the assigned workspace and final session status.
- Workspace layer OWNS: preparing, recreating, and archiving local workspaces for delivery and resume.
- Review gates READ: PhaseArtifact records to link approvals and feedback to the correct proposal.
- Agent sessions DO NOT OWN: branch naming, commits, pushes, labels, comments, proposal creation, proposal target branch, duplicate proposal decisions, or phase artifact status.

## Event Flows

**Design artifact delivery flow**
1. Control Plane starts a design session with artifact-only instructions.
2. Agent Service writes architecture artifacts and traceability updates in the workspace.
3. Control Plane packages the changed artifacts into a PhaseArtifact.
4. Control Plane creates or updates the phase review proposal targeting the configured staging branch.
5. Control Plane records the proposal reference and parks the run at the review gate.
6. Operator reviews the proposal and applies the approval or rejection signal.

**Generation artifact delivery flow**
1. Control Plane starts a generation session with artifact-only instructions.
2. Agent Service writes stack-specific artifacts and traceability updates.
3. Control Plane packages the changed artifacts into the phase review proposal.
4. Control Plane records the PhaseArtifact.
5. Compliance review and implementation phases consume the recorded artifact chain.

**Gate approval resume flow**
1. Control Plane observes the gate approval signal.
2. Control Plane reconciles the recorded PhaseArtifact.
3. If the proposal is merged, the workspace layer prepares a workspace from the target branch at or after the merge identifier.
4. Control Plane clears obsolete workspace references and advances the run.
5. If the proposal is not merged, the run remains parked and the Operator is notified.

**Gate feedback flow**
1. Control Plane observes a rejection or feedback signal.
2. Control Plane reads feedback attached after the latest PhaseArtifact update.
3. Control Plane resumes the authoring phase with feedback context.
4. Agent Service updates the artifacts in the workspace.
5. Control Plane updates the same review proposal and records a new PhaseArtifact revision.

## Error Handling

**No changed artifacts:** If a phase requires output and no changed artifacts are found, return a delivery-failed result with an agent-output failure kind. Do not open an empty proposal.

**Out-of-scope artifact:** Reject the delivery and route through recoverable failure handling if the workspace contains changes outside the phase scope.

**Duplicate proposal detected:** Reuse or update the existing proposal when it matches ProposalKey. If multiple proposals match, pause the run and notify the Operator because automatic selection is unsafe.

**Wrong target branch:** Reject before proposal creation. The target branch must match DeliveryPolicy.

**Proposal host unavailable:** Record a recoverable delivery failure and retry according to recoverable failure routing. Do not mark the work request permanently stuck on the first transient host failure.

**Recorded artifact missing on resume:** Treat as corrupted run state. Pause for repair if the artifact can be reconstructed from the proposal; otherwise escalate to human review.
