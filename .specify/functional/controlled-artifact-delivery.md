---
id: FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY
type: functional
domain: auto-claude
status: approved
version: 2
layer: 1
---

# FUNC-AC-CONTROLLED-ARTIFACT-DELIVERY — Controlled Artifact Delivery

> **Operator-approved 2026-07-03 (Decision D2 of the first-production-deployment program plan).** This v2 content was ratified via the Operator specification-content gate. L2/L3 remain draft until the Phase-9 live proof.
>
> **Spec history (v2, 2026-07-02):** v1 governed the controlled delivery of the artifacts the platform produces — chiefly generated specification documents — ensuring one autonomous session cannot decide its own delivery identity, target, or proposal lifecycle. v2 extends the same controlled-delivery discipline to the platform's most consequential artifact, a **code change** bound for a deployment's live line of work: a code change always arrives as a review proposal against the deployment's single trunk, joins that trunk only through the deployment's own controlled, checked path once the merge decision has cleared it, takes its landing target from the deployment's declared profile, and — because a change that looked sound can still break the trunk — is watched after it lands so that a change which turns the trunk red is met with an automatic reversal rather than left standing. A deployment that has declared no delivery profile may still deliver by a direct, ungoverned join, but that path is always recorded as ungoverned so it is never mistaken for the controlled lane. Every v1 spec-artifact guarantee is carried forward unchanged. Extending the content re-opens the Operator's specification-content gate, so status returns to `draft` pending his approval.

## Problem Statement

Autonomous sessions produce useful artifacts, but reliability breaks down when those sessions also decide branch names, commit boundaries, review targets, labels, comments, and proposal lifecycle. Delivery decisions are system coordination concerns. They must be deterministic, traceable, and owned by the Control Plane so one work request cannot create duplicate proposals or target the wrong integration branch.

The same discipline must govern how a finished code change reaches a deployment's shared trunk. The session that wrote a change must never improvise how it lands. A code change has to arrive as a review proposal against the deployment's single trunk, join that trunk only through the deployment's own controlled, checked path once the change has been cleared to proceed, and land on the trunk the deployment declared — never one the platform assumed. And because a change that passed every check before landing can still break the trunk once it is there, delivery cannot end at the join: a change that turns the trunk red must be reversed and surfaced to the Operator, never left to rot. Where a deployment has declared no delivery profile at all, a change may still be delivered by a direct, ungoverned join, but that path must announce itself as ungoverned so it is never mistaken for the controlled lane and so the honest state of the deployment is always visible.

## Actors

- **Operator** - reviews proposals, approves gated work, and decides a reversal when a landed change turns the trunk red
- **Spec Author** - reviews generated specification artifacts
- **Control Plane** - owns artifact packaging, delivery records, labels, comments, review proposals, the controlled join to the trunk, post-landing observation, and reversal proposals
- **Agent Service** - writes artifacts and code changes inside the assigned workspace and reports completion status

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
- When the target branch differs from the single configured trunk
- Then delivery is rejected before the proposal becomes operator-visible

**Scenario: Trunk target is not a per-deployment choice**
- Given a deployment configures its delivery policy
- When that policy attempts to set the integration target to any branch other than the single trunk
- Then the configuration is rejected, because the trunk is a fixed safety floor rather than a tunable per-deployment setting

**Scenario: Code changes are delivered only as a review proposal**
- Given the Agent Service has finished a code change in its workspace
- When the Control Plane delivers that change
- Then the change is packaged as a review proposal against the deployment's single trunk, and the session that wrote it never joins it to the trunk itself

**Scenario: The landing target comes from the deployment's declared profile**
- Given a deployment's profile declares the single trunk its changes land on
- When the Control Plane delivers a code change for that deployment
- Then the review proposal targets exactly that declared trunk, and the target is taken from the declaration rather than assumed

**Scenario: A cleared code change joins the trunk through the controlled, checked path**
- Given the merge decision has cleared a code change to proceed on the platform's judgement
- When the Control Plane joins the change to the trunk
- Then the join is performed through the deployment's own controlled path, only after the deployment's required checks have passed, and the review proposal is recorded as joined

**Scenario: A held or escalated code change parks its proposal**
- Given the merge decision holds a code change or escalates it to the Operator
- When the Control Plane advances the run
- Then the review proposal remains the parked artifact the Operator's decision refers to, and no join to the trunk occurs until the decision clears it

**Scenario: A profile-less deployment falls back to an ungoverned direct join**
- Given a deployment that has declared no delivery profile
- When the Control Plane delivers a code change for it
- Then the change may be delivered by a direct, ungoverned join to the mainline, and every such delivery is recorded as ungoverned so it is never mistaken for the controlled lane

**Scenario: The trunk is observed after a change lands**
- Given a code change has joined the trunk on the platform's judgement
- When the deployment's required checks on the trunk are observed after the join
- Then their outcome is recorded against the delivered change

**Scenario: A change that turns the trunk red is met with an automatic reversal**
- Given a code change that joined the trunk on the platform's judgement
- When the trunk's required checks go red after the join, or their health cannot be established with confidence
- Then the Control Plane prepares a proposal to undo that change and surfaces a reversal decision to the Operator, rather than leaving the red change standing on the trunk

**Scenario: The Operator decides a reversal in one step**
- Given a reversal has been raised for a change that turned the trunk red
- When the Operator approves the reversal
- Then the change is undone from the trunk and the reversal is recorded

**Scenario: A reversal joins autonomously only under the same gate as any autonomous join**
- Given a reversal has been prepared for a change that turned the trunk red
- When the reversal is considered for the trunk without the Operator having decided it
- Then it joins the trunk on the platform's judgement only if it clears the same verifier gate that governs any autonomous join; otherwise it is held for the Operator

**Scenario: Durable phase artifact record**
- Given a delivery proposal is created, updated, merged, rejected, or superseded
- When the Control Plane advances or parks the run
- Then the run state records the artifact type, source branch, target branch, proposal identifier, artifact paths, status, merge identifier if available, and the post-landing observation and any reversal for a code change

**Scenario: Gate resume from delivered artifact**
- Given a gated phase is approved after its proposal is merged
- When the Control Plane resumes the run
- Then subsequent phases start from the merged artifact on the trunk, not from stale pre-merge workspace state

**Scenario: Delivery failure routing**
- Given packaging or proposal creation fails for an infrastructure reason
- When the failure is recoverable
- Then the run records a repairable delivery failure rather than marking the work request permanently stuck

## Success Criteria

- Design and generation sessions cannot directly create delivery proposals
- Review proposals are unique for each work request and phase
- Review proposals always target the single configured trunk, which no deployment policy may redirect to another branch
- A code change is never delivered except as a review proposal against the deployment's single declared trunk; the session that wrote it never joins it to the trunk directly
- A code change joins the trunk on the platform's judgement only after the merge decision has cleared it and the deployment's required checks have passed
- The trunk each change lands on is taken from the deployment's declared profile, never assumed
- A deployment with no declared delivery profile can still be delivered to, but every such delivery is recorded as ungoverned
- A change that turns the trunk red after landing is always met with an automatic reversal proposal and an Operator decision — the trunk is never knowingly left red without a raised reversal
- An automatic reversal never joins the trunk on the platform's judgement except under the same verifier gate that governs any autonomous join
- Run state contains enough phase artifact metadata to resume after approval or restart
- Gate transitions reconcile against the recorded artifact before continuing

## Constraints

- Sessions may modify only artifacts inside their assigned workspace and declared scope
- The Control Plane is the only component that writes external labels, comments, delivery records, review proposals, controlled trunk joins, and reversals for pipeline phases
- Delivery records must be idempotent across daemon restarts and phase retries
- Existing operator approvals must be preserved during retries
- Delivery ownership must not bypass quality, safety, or release approval gates
- There is a single integration trunk for all delivery. The trunk is a fixed safety floor: no deployment, profile, or runtime change may redirect the integration target to a separate standing integration branch. A delivery whose target is anything other than the trunk is rejected before it becomes operator-visible
- A deployment's profile declares which single line is its trunk, and the landing target for every code change is taken from that declaration; naming the trunk in the profile never adds a second standing integration line, and a profile that attempts a second one is rejected under the single-trunk floor above
- Whether a code change may join the trunk is the merge decision's to make (owned by FUNC-AC-MERGE-DECISION); this spec governs only that the change is delivered as a review proposal against the single trunk, joined through the controlled checked path, recorded, observed after it lands, and reversed if it turns the trunk red
- The direct, ungoverned join exists only for a deployment that has declared no delivery profile, and every use of it is recorded as ungoverned; it is never the controlled lane and is never presented as governed delivery
- Post-landing observation and the reversal lane are fail-closed: doubt about a landed change's effect on the trunk resolves to raising a reversal decision for the Operator, and an automatic reversal may itself join the trunk only under the verifier gate that governs any autonomous join — never on a weaker basis
- Promoting integrated work toward production is a release event taken from the trunk, not a merge into a second standing branch. Any staging-versus-production separation a regulated deployment needs is expressed as stricter checks that run after work reaches the trunk — additional verification, environment approvals, controlled rollout, and the operator's production-release approval — never as a different delivery target
