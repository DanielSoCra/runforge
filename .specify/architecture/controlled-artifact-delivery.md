---
id: ARCH-AC-CONTROLLED-ARTIFACT-DELIVERY
type: architecture
domain: auto-claude
status: draft
version: 2
layer: 2
references: FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY
---

# ARCH-AC-CONTROLLED-ARTIFACT-DELIVERY - Controlled Artifact Delivery

> **v2 (2026-07-02, draft):** extends the controlled-delivery architecture from specification artifacts to **code changes** bound for a deployment's live trunk. A code change is delivered as a review proposal against the deployment's declared trunk, joins that trunk only through the Control Plane's controlled, checked path once the merge decision has cleared it and required checks pass, takes its landing target from the deployment's declared profile, is observed after it lands, and is met with an automatic reversal proposal when it turns the trunk red. A profile-less deployment may still deliver by a direct join, but that join is recorded as ungoverned. Every v1 specification-artifact contract below is preserved unchanged; the code-delivery content is additive.

## Overview

Controlled Artifact Delivery separates artifact authoring from artifact delivery. Agent sessions write files in a prepared workspace. The Control Plane then packages those file changes into a deterministic delivery unit, records the unit in run state, opens or updates the review proposal, and parks or advances the run according to the relevant gate.

For a code change this same discipline extends past the proposal to the trunk: the Control Plane opens the proposal against the deployment's declared trunk, joins it to the trunk only through its own controlled, checked path once the Merge Decision system clears the change and the required checks pass, observes the trunk after the change lands, and prepares a reversal proposal when the landed change turns the trunk red. The session that wrote the change never joins it to the trunk itself. A deployment that declares no delivery profile may fall back to a direct, ungoverned join, which is always recorded as ungoverned.

This architecture is the delivery contract for gated specification phases, for code-change phases delivered to a trunk, and for any future phase that produces externally reviewed artifacts.

## Data Model

**PhaseArtifact** records the durable output of one pipeline phase. It contains: work request identifier, phase name, artifact kind, artifact paths, source branch, target branch, proposal identifier, status, created timestamp, updated timestamp, and optional merge identifier. For a code-change phase it additionally carries the merge decision reference, the post-landing observation, and any reversal reference.

**ArtifactKind** is one of: specification artifact or code change. A code-change artifact is delivered against a deployment's trunk and is subject to post-landing observation and reversal; a specification artifact is not.

**ArtifactStatus** is one of: prepared, proposed, awaiting-review, merged, joined, observed-healthy, observed-red, reversal-raised, reverted, rejected, superseded, or delivery-failed. `joined` marks a code change that has entered the trunk through the controlled path; `observed-healthy` / `observed-red` record the trunk's health after it landed; `reversal-raised` and `reverted` track the reversal lane.

**LandingTarget** is read from the deployment's declared profile. It names the single trunk a code change lands on and the declared path to production release. Only the trunk name governs delivery in this architecture; the release path is consumed by the release architecture, not here. A deployment that declares no LandingTarget has no controlled lane and falls back to the ungoverned direct join.

**MergeDecisionReference** links a code-change PhaseArtifact to the verdict the Merge Decision system returned for it — auto-merge, hold, or escalate — so the delivery record shows on whose judgement the change joined or why it parked.

**PostLandingObservation** records what the trunk's required checks reported for the merge commit after a code change joined: healthy, red, or indeterminate, together with the observed commit identifier and the time observed. Indeterminate is treated as red for the reversal decision (fail-closed).

**ReversalProposal** records a proposal to undo a landed code change that turned the trunk red. It references the original delivery, carries its own proposal identity and status, and records whether it joined the trunk under the verifier gate or is parked for the Operator's reversal decision.

**UngovernedJoinRecord** marks a direct join performed for a profile-less deployment. It records that the join bypassed the controlled lane so the honest, ungoverned state of that delivery is always visible and never presented as governed delivery.

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

**Deliver code change** - Called by the Control Plane when a code-change phase completes. Request: DeliveryRequest whose landing target is the deployment's declared trunk. Response: DeliveryResult.

The operation:
1. Resolves the trunk from the deployment's declared LandingTarget; rejects delivery if the target is anything other than the single trunk, or if a configured deployment declares no landing target reachable to the controlled lane.
2. Pushes the feature branch and creates or updates exactly one review proposal targeting the declared trunk.
3. Records the code-change PhaseArtifact as `proposed`; the session never joins the change to the trunk.

**Join cleared code change** - Called by the Control Plane after the Merge Decision system returns an auto-merge verdict (or an Operator approval stands in for it). Request: the code-change PhaseArtifact. Response: updated PhaseArtifact.

The operation:
1. Awaits the proposal's required checks (see below); does not proceed on red or timeout.
2. Joins the change to the trunk through the proposal host's controlled merge, records the merge identifier, and marks the artifact `joined`.
3. Returns without joining, routing to escalation, if the merge decision did not clear the change.

**Await required checks** - Called before any controlled join. Request: proposal identifier and a bounded timeout. Response: pass, red, or timed-out. Red or timed-out never falls through to a join; it routes the change to the escalation surface. Checks are never bypassed.

**Observe trunk after landing** - Called after a controlled join. Request: the joined code-change PhaseArtifact. Response: PostLandingObservation. Reads the trunk's required checks for the merge commit and records healthy, red, or indeterminate against the delivered change. Indeterminate resolves to red.

**Raise reversal** - Called when a PostLandingObservation is red. Request: the joined code-change PhaseArtifact. Response: ReversalProposal. Prepares a proposal to undo the change and raises an Operator reversal decision. A prepared reversal joins the trunk on the platform's judgement only if it clears the same verifier gate that governs any autonomous join; otherwise it is held for the Operator.

**Reconcile phase artifact** - Called before a gated run resumes. Request: run identifier, work request identifier, and phase name. Response: the latest PhaseArtifact and whether the workspace must be recreated.

The operation:
1. Loads the recorded PhaseArtifact.
2. Checks the proposal status.
3. If merged or joined, verifies that the merge identifier is present on the target branch.
4. Marks old workspaces obsolete when they predate the merged artifact.
5. Returns a resume base that the workspace layer can use to prepare a fresh workspace.

**Find duplicate proposal** - Called during package and repair flows. Request: ProposalKey. Response: existing proposal reference or none.

## System Boundaries

- Control Plane OWNS: DeliveryPolicy evaluation, proposal keys, phase artifact records, label and comment updates, proposal creation and update, the controlled join of a cleared code change to the trunk, the bounded wait on required checks, post-landing observation, reversal-proposal preparation, and proposal status reconciliation.
- Merge Decision system OWNS: whether a code change may join the trunk (auto-merge, hold, escalate). This architecture carries out the join only after that verdict clears the change and never re-decides it. Whether an automatic reversal may join without the Operator is the verifier gate's decision, owned by the verifier-gate architecture; this architecture only routes the reversal through it.
- Deployment profile OWNS: the LandingTarget declaration. The trunk each code change lands on is read from that declaration, never assumed. The trunk is a fixed safety floor; no profile or runtime change may redirect delivery to a second standing integration line.
- Agent Service OWNS: artifact authoring inside the assigned workspace and final session status. It never joins a change to the trunk.
- Workspace layer OWNS: preparing, recreating, and archiving local workspaces for delivery and resume.
- Review gates READ: PhaseArtifact records to link approvals and feedback to the correct proposal.
- Agent sessions DO NOT OWN: branch naming, commits, pushes, labels, comments, proposal creation, proposal target branch, duplicate proposal decisions, trunk joins, post-landing observation, reversals, or phase artifact status.
- There is exactly one controlled reversal path. Any dormant or duplicate reversal scaffolding is quarantined so it is never mistaken for the live rollback path; a configuration that does not enable the controlled lane has no reversal net, and that absence is visible rather than simulated by inert scaffolding.
- The direct, ungoverned join belongs only to a deployment that declares no landing profile. Every use of it is recorded as ungoverned and is never presented as the controlled lane.

## Event Flows

**Design artifact delivery flow**
1. Control Plane starts a design session with artifact-only instructions.
2. Agent Service writes architecture artifacts and traceability updates in the workspace.
3. Control Plane packages the changed artifacts into a PhaseArtifact.
4. Control Plane creates or updates the phase review proposal targeting the configured trunk.
5. Control Plane records the proposal reference and parks the run at the review gate.
6. Operator reviews the proposal and applies the approval or rejection signal.

**Generation artifact delivery flow**
1. Control Plane starts a generation session with artifact-only instructions.
2. Agent Service writes stack-specific artifacts and traceability updates.
3. Control Plane packages the changed artifacts into the phase review proposal.
4. Control Plane records the PhaseArtifact.
5. Compliance review and implementation phases consume the recorded artifact chain.

**Code change delivery — controlled join**
1. Control Plane resolves the trunk from the deployment's declared LandingTarget.
2. Control Plane pushes the feature branch and opens or updates one review proposal against that trunk, recording a `proposed` code-change PhaseArtifact.
3. Control Plane asks the Merge Decision system for a verdict; on auto-merge it awaits the proposal's required checks with a bounded timeout.
4. On checks-pass, Control Plane joins the change through the proposal host's controlled merge, records the merge identifier, and marks the artifact `joined`.
5. Control Plane observes the trunk's required checks for the merge commit and records the PostLandingObservation.

**Code change delivery — held or escalated**
1. Control Plane opens or updates the review proposal against the trunk as above.
2. The Merge Decision system returns hold or escalate.
3. Control Plane parks the run; the review proposal remains the artifact the Operator's decision refers to, and no join occurs until a decision clears it.
4. On the Operator's clearance, the run resumes and re-enters the controlled-join flow from the checks wait.

**Profile-less ungoverned direct join**
1. A deployment that declares no landing profile completes a code change.
2. Control Plane performs a direct join to the mainline and writes an UngovernedJoinRecord.
3. The delivery is surfaced as ungoverned so the honest state of the deployment is visible; it is never presented as controlled delivery.

**Post-landing observation and automatic reversal**
1. After a controlled join, Control Plane reads the trunk's required checks for the merge commit.
2. A healthy observation is recorded against the delivered change and the flow ends.
3. A red or indeterminate observation prepares a ReversalProposal and raises an Operator reversal decision.
4. The prepared reversal joins the trunk on the platform's judgement only if it clears the verifier gate; otherwise it stays parked for the Operator, who approves the reversal in one step.

**Gate approval resume flow**
1. Control Plane observes the gate approval signal.
2. Control Plane reconciles the recorded PhaseArtifact.
3. If the proposal is merged or joined, the workspace layer prepares a workspace from the target branch at or after the merge identifier.
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

**Wrong target branch:** Reject before proposal creation. The target branch must be the deployment's declared trunk. A configured deployment whose declared landing target is missing or is any branch other than the single trunk is rejected before the proposal becomes operator-visible; it is never silently redirected.

**Required checks red or timed out:** The controlled join does not proceed. The change is routed to the escalation surface and the proposal is left parked. Checks are never bypassed to force a join.

**Post-landing health indeterminate:** Treated as red (fail-closed). A ReversalProposal is prepared and an Operator reversal decision is raised rather than leaving a possibly-red change standing on the trunk.

**Reversal cannot auto-join:** A prepared reversal that does not clear the verifier gate is not joined on the platform's judgement; it stays parked for the Operator. A reversal is never joined on a weaker basis than any other autonomous join.

**Proposal host unavailable:** Record a recoverable delivery failure and retry according to recoverable failure routing. Do not mark the work request permanently stuck on the first transient host failure. If the escalation surface itself is unavailable for a configured deployment, fail closed and hold the change visibly rather than joining it or parking it silently.

**Recorded artifact missing on resume:** Treat as corrupted run state. Pause for repair if the artifact can be reconstructed from the proposal; otherwise escalate to human review.
