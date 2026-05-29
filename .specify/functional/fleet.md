---
id: FUNC-AC-FLEET
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-FLEET — Fleet & Deployment Management

## Problem Statement

The platform now runs more than one project at once, and the projects are not alike. One is a regulated platform where almost nothing may ship without a human; another is a product site where nearly everything is safe to automate; a third is a small content website with no regulated paths at all. Today the platform behaves as though there is one project shaped like the first one — its risk rules, its compliance reviewers, its budget, and its honest map of what cannot be automated are baked into the platform itself. Adding a project means forking the platform.

Two failures follow from this. First, there is no single place that says, per project, *which* repositories it owns, *how* its changes are classified by risk, *which* domain reviewers gate it, *what* it can and cannot automate, *how much* it may spend, and *where* its changes are allowed to land first. Without that per-project record, the platform cannot widen autonomy on one project without widening it everywhere, and the Operator cannot see why a given project behaves the way it does.

Second, the substrate the projects share — the reusable capabilities, instructions, and learned behavior that every project draws on — currently changes for every project at once, instantly. A bad change to a shared capability is exposed to the highest-stakes project at the same moment it reaches the lowest-stakes one, with no chance to catch it on something cheap first, and no way to take it back across the whole fleet once it has done harm.

The Operator needs each project to be a self-describing **deployment** with its own profile; needs the projects isolated by default so attention is not fragmented, with a single cross-project surface that only interrupts when something is important enough; needs shared capability changes to prove themselves on a low-stakes deployment before reaching the rest; and needs every project's spend bounded and every bad shared change — a capability version or a learned bias — reversible across the entire fleet.

## Actors

- **Operator** — registers and shapes deployments, sets each one's risk rules, compliance reviewer set, honest-automation boundary, budget, where its changes may land first, and the path by which its changes are released to production; approves widening a deployment's autonomy; approves each production release; decides cross-fleet rollbacks; sets how much of other deployments' activity is allowed to interrupt the current focus
- **Control Plane** — reads the registry to apply each deployment's profile, isolates deployments from one another, runs the cross-deployment inbox under the Operator's focus rules, drives a shared change through staged rollout, enforces per-deployment budgets, and executes fleet-wide rollbacks

## Behavior

### Deployment profile

**Scenario: Registering a project as a deployment**
- Given the Operator wants the platform to run a new project
- When they register it in the Fleet Registry with its profile — the repositories it owns, its risk-classification rules, its compliance reviewer set, its automatable/strained/irreducibly-human map, its budget, where its changes may land first, and the path by which its changes are released to production
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

### Capability ingress

**Scenario: An updated capability is adopted as a version**
- Given a reusable capability or instruction has been improved at the Capability Source
- When the platform adopts it
- Then it is taken in as a specific, identified version recorded in the Fleet Registry
- And a deployment runs against a known capability version, never against whatever happens to be edited live

**Scenario: A capability version is bound per deployment**
- Given a capability version has been adopted
- When the Operator chooses where it applies
- Then the Fleet Registry records which deployments run which version
- And it is visible which deployments share a capability, so the blast radius of a change to it is known before it ships

### Canary rollout

**Scenario: A shared-substrate change ships to a low-stakes deployment first**
- Given a change to a capability, instruction, or learned behavior is shared across deployments
- When it is rolled out
- Then it is applied first to a low-stakes deployment designated to receive changes before the rest
- And it is not applied fleet-wide at the moment it is adopted

**Scenario: A change promotes only after proving green**
- Given a shared change is in force on the low-stakes deployment
- When that deployment's gates and outcomes stay green over the deployment's proving window
- Then the change is promoted to the remaining deployments in their designated order
- And until then the other deployments keep the version they were on

**Scenario: A change that fails on the canary does not promote**
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
- No shared change reaches the full fleet without first proving green on a low-stakes deployment; a shared change that fails on that deployment never promotes, and the Operator is told why.
- Every deployment stays within its own budget; nearing the limit produces a decision, never a silent overspend or silent stall.
- A bad shared capability version and a bad learned bias are both reversible across the entire fleet, leaving no deployment on the bad version or behavior, with the reversal recorded so it is not silently re-applied.

## Constraints

- A deployment is governed only by its own profile; no project-specific rule, reviewer, boundary, budget, or rollout setting is part of the platform itself.
- The honest map of what can and cannot be automated is a per-deployment property, never the platform's; the platform optimizes for concentrating the Operator's attention on each deployment's irreducibly-human work and does not pretend that work away.
- A deployment is fully human-gated at registration; its autonomy may widen only along a proven, risk-class-by-risk-class ramp, and only with the Operator's approval — autonomy is earned per deployment, never granted at switch-on.
- Deployments are isolated by default; one deployment's routine activity must never surface inside another, and the cross-deployment inbox is the only exception.
- An item from a non-focused deployment must never be silently dropped; it either interrupts because it meets the Operator's threshold or accrues for later, and cross-deployment priority must always be explainable, never a hidden global ranking.
- The platform adopts capabilities only as identified versions recorded in the registry; it never acts on live, unversioned edits to shared capabilities or instructions.
- A change to shared substrate must reach a low-stakes deployment before any higher-stakes deployment and must never be applied fleet-wide in a single step; promotion to the rest is conditional on the canary staying green.
- Each deployment's spend is bounded by its own budget independently of the others; a deployment may not exceed its budget without an Operator decision.
- A promoted shared capability version and an adopted learned behavior must both be reversible fleet-wide to a prior known-good state; sensitive knowledge is never auto-promoted, and every rollback is recorded so a withdrawn version or behavior is not silently re-applied.
- This capability coordinates the fleet; it never merges, never deploys, never alters a pipeline phase, and never edits or authors specifications or the vision — those boundaries hold across every deployment.
