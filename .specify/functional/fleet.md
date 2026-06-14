---
id: FUNC-AC-FLEET
type: functional
domain: auto-claude
status: approved
version: 2
layer: 1
---

# FUNC-AC-FLEET — Fleet & Deployment Management

> **Spec history (v2, 2026-06-11):** v2 adds the capacity-pool behavior (per-pool usage windows, failover on exhaustion, recorded provenance of which pool performed each review) for the v-next masterplan's window-aware scheduling (workstream M3). Which pools exist and their preference order are configuration values illustrated in the non-normative default configuration pack example, never requirements of this spec. v1 (approved) is otherwise carried forward unchanged.
>
> **Spec history (v2.1, 2026-06-11, alignment interview):** Names the economic objective the capacity routing and its records serve: **intelligence-fit per task class** — the minimal capability tier that sustains the lane's quality bar — not raw cost minimization. The Operator's framing: better-fit intelligence means cheaper runs, which means more throughput, higher quality, and higher confidence — more automation and more leverage; frontier capability is not needed everywhere. The records must make fit measurable (attempts-to-pass, review-rejection rates per tier); the tier and routing values themselves remain config-pack data.
>
> **Spec history (v2.2, 2026-06-14, L0 v6 enactment):** Re-approval pass. Aligns the autonomy-widening language with the Operator's earn-in ruling (L0 v6): the Operator's approval that widens a deployment's autonomy may be given **per event** or **in advance** as a pre-approved earn-in policy (the earn-in mechanism itself lives in FUNC-AC-MERGE-DECISION v2.2; this spec owns the per-deployment autonomy state it updates and the fleet-wide reversibility — demote-on-red — that every auto-promotion remains subject to). No invariant changes: pre-approval is bounded to verifier-gated, autonomous-eligible lanes, and every widening is recorded and reversible. This sets `status: approved`.

## Problem Statement

The platform now runs more than one project at once, and the projects are not alike. One is a regulated platform where almost nothing may ship without a human; another is a product site where nearly everything is safe to automate; a third is a small content website with no regulated paths at all. Today the platform behaves as though there is one project shaped like the first one — its risk rules, its compliance reviewers, its budget, and its honest map of what cannot be automated are baked into the platform itself. Adding a project means forking the platform.

Two failures follow from this. First, there is no single place that says, per project, *which* repositories it owns, *how* its changes are classified by risk, *which* domain reviewers gate it, *what* it can and cannot automate, *how much* it may spend, and *where* its changes are allowed to land first. Without that per-project record, the platform cannot widen autonomy on one project without widening it everywhere, and the Operator cannot see why a given project behaves the way it does.

Second, the substrate the projects share — the reusable capabilities, instructions, and learned behavior that every project draws on — currently changes for every project at once, instantly. A bad change to a shared capability is exposed to the highest-stakes project at the same moment it reaches the lowest-stakes one, with no chance to catch it on something cheap first, and no way to take it back across the whole fleet once it has done harm.

The Operator needs each project to be a self-describing **deployment** with its own profile; needs the projects isolated by default so attention is not fragmented, with a single cross-project surface that only interrupts when something is important enough; needs shared capability changes to prove themselves on a low-stakes deployment before reaching the rest; and needs every project's spend bounded and every bad shared change — a capability version or a learned bias — reversible across the entire fleet.

A further shared resource has the same shape. The fleet's reasoning capacity is drawn from a small number of **capacity pools** — subscriptions and accounts the Operator holds, each of which allows only so much work within its own recurring usage window. Today the platform behaves as if capacity were one undifferentiated well: when the well it happens to be drinking from runs dry, every deployment's work stalls until the window reopens, even though another pool stands idle. And because the platform does not record which pool actually performed a given piece of review work, a quality difference between pools — one pool's reviews quietly becoming weaker than another's — is invisible until it has already done harm. The fleet needs its pools tracked individually, work moved between them when one is exhausted, and every review's provenance recorded so drift between pools can be seen.

## Actors

- **Operator** — registers and shapes deployments, sets each one's risk rules, compliance reviewer set, honest-automation boundary, budget, where its changes may land first, and the path by which its changes are released to production; approves widening a deployment's autonomy; approves each production release; decides cross-fleet rollbacks; sets how much of other deployments' activity is allowed to interrupt the current focus
- **Control Plane** — reads the registry to apply each deployment's profile, isolates deployments from one another, runs the cross-deployment inbox under the Operator's focus rules, drives a shared change through staged rollout, enforces per-deployment budgets, tracks each capacity pool's usage window and moves work between pools, and executes fleet-wide rollbacks

## Behavior

### Deployment profile

**Scenario: Registering a project as a deployment**
- Given the Operator wants the platform to run a new project
- When they register it in the registry with its profile — the repositories it owns, its risk-classification rules, its compliance reviewer set, its automatable/strained/irreducibly-human map, its budget, where its changes may land first, and the path by which its changes are released to production
- Then the platform runs that project as a deployment using only that profile
- And no change to the platform itself is required to add the project

**Scenario: A deployment carries its own risk rules and reviewer set**
- Given two deployments are registered with different profiles
- When each one classifies and gates a change
- Then each uses its own risk-classification rules and its own compliance reviewer set
- And a change that one deployment's profile treats as low-risk is not forced to the rules or reviewers of another

**Scenario: A deployment carries its own honest-automation boundary**
- Given a deployment's profile records which of its work is automatable, which strains, and which is irreducibly human
- When the platform decides what to attempt and what to surface to the Operator
- Then it concentrates the Operator's attention on that deployment's irreducibly-human work and does not attempt to automate what the deployment's profile marks as irreducibly human

**Scenario: Trust widens per deployment, not fleet-wide**
- Given a deployment begins fully human-gated
- When its gates are proven over time and the Operator approves widening its autonomy for a given risk class
- Then only that deployment's autonomy widens for that risk class
- And other deployments' autonomy is unchanged

### Bounded isolation and the focus-gated inbox

**Scenario: Deployments are isolated by default**
- Given several deployments are running
- When the Operator is working
- Then each deployment's routine activity stays within that deployment and does not surface across deployments

**Scenario: The inbox is the only cross-deployment surface**
- Given a deployment raises a decision that needs the Operator
- When that decision is created
- Then it appears in a single cross-deployment inbox alongside decisions from other deployments
- And this inbox is the only place where one deployment's items appear next to another's

**Scenario: Focus gates interruptions from other deployments**
- Given the Operator is focused on one deployment and has set how important an item from elsewhere must be to interrupt
- When another deployment raises a decision
- Then it interrupts only if it meets or exceeds the Operator's interruption threshold
- And every other item from other deployments accrues quietly and is surfaced when the Operator turns to those deployments, never silently dropped

**Scenario: Cross-deployment priority is explainable**
- Given items from several deployments are present in the inbox
- When the Operator views their ordering
- Then each item shows why it is ranked where it is, and there is no hidden global ranking the Operator cannot inspect

### Adopting an improved shared capability

**Scenario: An updated capability is adopted as a version**
- Given a reusable capability or instruction has been improved at its shared-capability source
- When the platform adopts it
- Then it is taken in as a specific, identified version recorded in the registry
- And a deployment runs against a known capability version, never against whatever happens to be edited live

**Scenario: A capability version is bound per deployment**
- Given a capability version has been adopted
- When the Operator chooses where it applies
- Then the registry records which deployments run which version
- And it is visible which deployments share a capability, so the full set of deployments a change to it would affect is known before it ships

### Staged rollout — a low-stakes deployment first

**Scenario: A shared-substrate change ships to a low-stakes deployment first**
- Given a change to a capability, instruction, or learned behavior is shared across deployments
- When it is rolled out
- Then it is applied first to a low-stakes deployment designated to receive changes before the rest
- And it is not applied fleet-wide at the moment it is adopted

**Scenario: A change promotes only after proving healthy**
- Given a shared change is in force on the low-stakes deployment
- When that deployment's gates keep passing and its outcomes hold over the deployment's proving window
- Then the change is promoted to the remaining deployments in their designated order
- And until then the other deployments keep the version they were on

**Scenario: A change that fails on the low-stakes deployment does not promote**
- Given a shared change is in force on the low-stakes deployment
- When it fails the deployment's gates or degrades its outcomes during the proving window
- Then the change is not promoted to any other deployment
- And the Operator is told it was held back and why

### Per-deployment budget

**Scenario: Each deployment runs within its own budget**
- Given a deployment's profile sets a budget that caps its spend
- When the deployment runs its lifecycle and its autonomy widens
- Then its spend is held within its own budget independently of every other deployment

**Scenario: Approaching the budget surfaces a decision**
- Given a deployment is approaching its budget limit
- When the remaining budget falls below the deployment's safe margin
- Then the platform raises a decision to the Operator rather than silently overspending or silently halting
- And the deployment does not exceed its budget without the Operator's decision

### Capacity pools and usage windows

**Scenario: Each capacity pool's usage window is tracked individually**
- Given the platform's reasoning capacity is drawn from several configured capacity pools, each with its own recurring usage window
- When work consumes capacity from a pool
- Then the platform tracks that pool's remaining headroom within its current window, individually per pool — never as one undifferentiated total

**Scenario: Work fails over when a pool's window is exhausted**
- Given a piece of work would normally draw on a pool whose current window is exhausted or about to be
- When the work is dispatched
- Then it is carried by another configured pool able to serve it, in the Operator's configured preference order, instead of stalling until the exhausted window reopens

**Scenario: All pools exhausted pauses, never drops**
- Given every configured pool able to serve a piece of work is exhausted
- When the work is dispatched
- Then the platform pauses that work and resumes it when a window reopens — the work is never dropped, and the pause is visible to the Operator with its reason

**Scenario: Every review records which pool performed it**
- Given a piece of review work has completed
- When its verdict is recorded
- Then the record names the capacity pool (and the capability that served it) that performed the review, so that a later quality comparison between pools is possible from the records alone

**Scenario: Routing seeks intelligence-fit, and the records make fit measurable**
- Given the fleet's work classes differ in how much reasoning capability they genuinely need
- When work is routed to capability tiers and pools and its outcomes are recorded
- Then the objective the routing serves is fit — the least capable tier that still sustains the lane's quality bar — and the records carry what measuring fit requires: how many attempts a piece of work needed before its checks passed, and how often a tier's work was rejected in review, attributable per tier and per task class
- And both kinds of misfit are visible from the records alone — capability overshoot (the strongest tiers spent on routine work) and undershoot (a tier whose work repeatedly fails checks or review) — so the Operator can correct the routing configuration; the objective is never raw spend minimization at the expense of the quality bar

**Scenario: Pool preference is configuration**
- Given the Operator wants work to prefer one pool over another, or wants a pool removed from rotation
- When they edit the pool configuration
- Then later work follows the new preference without any change to the platform itself

### Demote-on-red rollback

**Scenario: A bad capability version is reverted fleet-wide**
- Given a capability version that has been promoted across deployments is found to cause harm
- When the Operator orders it demoted
- Then the platform reverts every affected deployment to the prior known-good version of that capability
- And no deployment is left running the bad version

**Scenario: A bad learned bias is reverted fleet-wide**
- Given the platform has adopted a learned behavior that turns out to be wrong
- When the Operator orders it reverted
- Then that learned behavior is withdrawn across every deployment that adopted it
- And the platform returns to escalating the affected decisions to the Operator as it did before the behavior was learned

**Scenario: A rollback is recorded and explainable**
- Given a fleet-wide rollback of a capability version or a learned behavior has been executed
- When the Operator reviews what changed
- Then the registry records which version or behavior was withdrawn, what each deployment was returned to, and why
- And a future rollout can see that this version was rolled back and not silently re-promote it

## Success Criteria

- Adding a project is registering a deployment profile, not changing the platform; the platform's behavior is uniform while everything project-specific lives in the deployment's profile.
- Each deployment classifies risk, gates compliance, bounds spend, and concentrates the Operator's attention on its irreducibly-human work using only its own profile; differences between deployments are explained by their profiles, not by special-casing.
- Autonomy widens for one deployment and one risk class at a time, only on the Operator's approval; widening one deployment never widens another.
- Deployments are isolated by default; the inbox is the only cross-deployment surface, and items from non-focused deployments interrupt only when they meet the Operator's threshold and otherwise accrue without being lost.
- No shared change reaches the full fleet without first proving healthy on a low-stakes deployment; a shared change that fails on that deployment never promotes, and the Operator is told why.
- Every deployment stays within its own budget; nearing the limit produces a decision, never a silent overspend or silent stall.
- A bad shared capability version and a bad learned bias are both reversible across the entire fleet, leaving no deployment on the bad version or behavior, with the reversal recorded so it is not silently re-applied.
- One capacity pool's exhausted window no longer stalls the fleet while another configured pool stands idle: eligible work fails over in the configured preference order, and only when every eligible pool is exhausted does work pause — visibly, with its reason, and resuming on its own when a window reopens.
- Every recorded review names the pool and capability that performed it, so a quality drift between pools is detectable from the records without re-running any work.
- Capacity routing demonstrably serves intelligence-fit per task class: the records expose, per tier and task class, attempts-to-pass and review-rejection rates, and both overshoot and undershoot are visible without re-running work — the lane's quality bar is never traded for cheaper capability.

## Constraints

- A deployment is governed only by its own profile; no project-specific rule, reviewer, boundary, budget, or rollout setting is part of the platform itself.
- The honest map of what can and cannot be automated is a per-deployment property, never the platform's; the platform optimizes for concentrating the Operator's attention on each deployment's irreducibly-human work and does not pretend that work away.
- A deployment is fully human-gated at registration; its autonomy may widen only along a proven, risk-class-by-risk-class ramp, and only with the Operator's approval — given per event, or in advance as a pre-approved earn-in policy bounded to verifier-gated, autonomous-eligible lanes (per FUNC-AC-MERGE-DECISION). Autonomy is earned per deployment, never granted at switch-on, and every widening is recorded and reversible fleet-wide.
- Deployments are isolated by default; one deployment's routine activity must never surface inside another, and the cross-deployment inbox is the only exception.
- An item from a non-focused deployment must never be silently dropped; it either interrupts because it meets the Operator's threshold or accrues for later, and cross-deployment priority must always be explainable, never a hidden global ranking.
- The platform adopts capabilities only as identified versions recorded in the registry; it never acts on live, unversioned edits to shared capabilities or instructions.
- A change to shared substrate must reach a low-stakes deployment before any higher-stakes deployment and must never be applied fleet-wide in a single step; promotion to the rest is conditional on the low-stakes deployment continuing to pass its gates.
- Each deployment's spend is bounded by its own budget independently of the others; a deployment may not exceed its budget without an Operator decision.
- A promoted shared capability version and an adopted learned behavior must both be reversible fleet-wide to a prior known-good state; sensitive knowledge is never auto-promoted, and every rollback is recorded so a withdrawn version or behavior is not silently re-applied.
- Capacity pools, their windows, and their preference order are **configuration values**, never platform behavior; the platform supplies the tracking and failover mechanism, the configuration supplies the pools and the order. Failing over between pools never weakens any gate: the same checks and decisions apply to a piece of work whichever pool carried it.
- Exhaustion handling is **fail-visible**: work waiting on capacity is paused and surfaced, never silently dropped; spend on a failover pool still counts against the same deployment budget as the work it carried.
- The routing objective is **intelligence-fit, never bare cost**: the platform supplies fit-measurable records (attempts-to-pass and review-rejection per tier and task class); which tiers exist and which task classes route where remain configuration values; and no routing choice — configured or learned — may sustain itself by lowering a lane's quality bar.
- This capability coordinates the fleet; it never merges, never deploys, never alters a pipeline phase, and never edits or authors specifications or the vision — those boundaries hold across every deployment.
