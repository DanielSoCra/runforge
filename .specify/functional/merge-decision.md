---
id: FUNC-AC-MERGE-DECISION
type: functional
domain: auto-claude
status: approved
version: 2
layer: 1
---

# FUNC-AC-MERGE-DECISION — Earned-Trust Merge Decision and Lanes

> **Spec history (v2, 2026-06-11):** v1 defined the four-level earned-trust decision. v2 generalizes it: the four risk levels remain the non-configurable caution floor, while the path a change travels — how it qualifies, who works on it at what capability level, which checks gate it, how it may join the shared mainline, and whether it is reviewed again afterwards — becomes deployment-configurable **lane** policy. One verification is deliberately excluded from configuration: the check that a change stayed within what its lane declared it may touch. This supersedes the earlier risk-class-rules approach tracked as issue #679 (the implementation phase closes that issue with a link here). Initial lane sets, earn-in bars, and the first regulated deployment's confirmed autonomy bar are **non-normative defaults** recorded in the default configuration pack example (`docs/superpowers/specs/2026-06-11-default-config-pack-example.md`) — they are illustrative data, not requirements of this spec.
>
> **Spec history (v2.1, 2026-06-11, alignment interview):** Adds the **deployment lifecycle mode** dimension, from the Operator's correction: *"First go fast and messy, then clean up, then be clinical when released. That's for acme but also for any other project. That's why the QA and review part matters even more than the planning."* Each deployment declares which phase of its life it is in (illustratively: velocity → hardening → clinical), and lane gate-sets and merge policies may vary by phase — so a pre-production deployment may run wider autonomous scope in a velocity mode, while the clinical treatment applies from the first production release onward. Phase transitions are Operator decisions surfaced as decision requests, never automatic; and no mode weakens the scope verification, the always-escalate set, the verification requirement, or the compliance lens — modes scale gate rigor, never bypass invariants. Phase names, meanings, and assignments are configuration (illustrated in the default configuration pack example), not requirements of this spec.
>
> **Spec history (v2.2, 2026-06-14, L0 v6 enactment):** Adds **pre-approved earn-in auto-promotion**, from the Operator's earn-in ruling alongside the L0 deltas. By default, meeting a lane's earn-in bar still raises a promotion DecisionRequest (v2 behavior, carried forward). In addition, a deployment may declare a **pre-approved earn-in policy** for a lane: the Operator's approval is then given *in advance*, and the lane auto-widens on meeting its bar without a per-promotion decision. The pre-approval is bounded and non-relaxable: it applies only to a **verifier-gated** lane (per FUNC-AC-VERIFIER-GATE) and only to risk levels eligible for an autonomous proceed — never orange, red, compliance-forced, or any always-escalate class — and every auto-promotion is recorded and remains reversible fleet-wide (demote-on-red, per FUNC-AC-FLEET). This sets `status: approved`, the Operator's re-approval of the amended content.

## Problem Statement

The platform finishes many changes on its own, and each one meets a single decision before it joins the deployment's shared mainline: may it proceed on the platform's judgement, or must it wait for the Operator? Getting this wrong in one direction starves the Operator of leverage — the platform produces work but never relieves him, which defeats its purpose. Getting it wrong in the other lets a change that deserved a human's eyes slide in unattended.

Today the platform can tell whether a change touched a regulated-sensitive path, and it holds a principle that autonomy is earned per deployment — but it has nowhere that decides, for an ordinary change, how risky it is and what that risk earns. The result is all-or-nothing: either everything is escalated to the Operator, or trust is granted wholesale. What is missing is a graduated, by-construction decision that sorts each change by how much it could harm the shared mainline, lets the safest changes proceed on proof alone, requires an independent check for slightly riskier ones, reserves the Operator's attention for changes that genuinely need it, and starts every deployment fully cautious — widening only as trust is earned.

A second gap follows from the first. Even with risk levels, the *path* a change travels is one-size-fits-all: every change gets the same depth of checking, the same kind of implementer and reviewer, and the same merge treatment, however trivial or weighty it is. A wording fix does not need the same ceremony as a cross-cutting refactor, and forcing both through one path wastes capacity on the former and under-serves the latter. The deployment — not the platform — knows which classes of change it sees and what each class deserves. So the path itself must become deployment policy: named **lanes**, each declaring how changes qualify for it, what such changes are allowed to touch, who works on them at what capability level, which checks must pass, how a qualifying change may join the shared mainline, and whether merged changes receive a later batch review. But one piece must never be policy: when the platform itself sorted a change into a lane, its own sorting can be wrong, so the platform must always verify that what the change *actually touched* stays within what its lane permits — a safeguard against the platform's own classification errors that no configuration may weaken. This decision is the engine of earned trust; without it the platform cannot safely take routine work off the Operator's plate, which is the whole point of building it.

## Actors

- **Operator** — the human who decides any change the platform holds for them, who shapes each deployment's lane policy in its profile, and who explicitly grants a deployment the autonomy to handle a given risk level or lane on its own
- **Control Plane** — sorts each completed change into a lane and a risk level, verifies the change against its lane's declared scope, requires the checks that lane and level demand, holds the change until they pass, and either lets it proceed or routes it to the Operator as a decision
- **Reviewer** — the platform's independent, heterogeneous quality review (the never-self-certifying review owned by FUNC-AC-QUALITY), performed by the platform rather than the Operator, that returns a clear pass-or-block verdict; required for the yellow risk level before a change may proceed without the Operator. This is distinct from the **Compliance Reviewer** below — one judges quality, the other the regulatory lens
- **Compliance Reviewer** — the deployment's regulatory lens, defined in FUNC-AC-COMPLIANCE-GATE, whose verdict composes with and can override this decision
- **Worker** — the autonomous run that produced the change and is waiting on the decision; it cannot send a change to the shared mainline until the decision clears it

## Behavior

### Risk levels — the non-configurable caution floor

**Scenario: Every completed change is sorted into a risk level first**
- Given a change the platform has finished
- When the change is ready to be considered for the shared mainline
- Then it is first sorted into one of four risk levels by how much it could affect the shared mainline — its reach, its sensitivity, and how reversible it is: green (lowest — routine, easily reversible work such as wording, formatting, or a routine dependency refresh), yellow (low — small and bounded, touching nothing sensitive or security-bearing), orange (meaningful risk), or red (the highest risk, or work in an area that is structurally a human's to decide)

**Scenario: A green change proceeds on proof alone, once trust is earned**
- Given a deployment that has earned autonomy for green changes
- And a green change whose verification has passed
- When it is considered for the shared mainline
- Then it proceeds without the Operator

**Scenario: A yellow change proceeds after an independent review, once trust is earned**
- Given a deployment that has earned autonomy for yellow changes
- And a yellow change whose verification has passed
- When an independent Reviewer returns a pass verdict
- Then it proceeds without the Operator

**Scenario: An orange or red change always reaches the Operator**
- Given an orange or red change
- When it is considered for the shared mainline
- Then it is held and surfaced to the Operator as a decision, no matter how much autonomy the deployment has earned

**Scenario: A red level can never be earned away**
- Given a deployment with as much earned autonomy as it has ever held
- When a red change is considered
- Then it still reaches the Operator — the red level is never eligible for an autonomous proceed, however much trust the deployment has accrued

**Scenario: No verification means no autonomous proceed**
- Given a change whose verification is missing, incomplete, or did not pass
- When it is considered for the shared mainline
- Then it never proceeds on the platform's judgement and is held for the Operator, whatever its risk level or lane

**Scenario: A regulated-sensitive change is forced to the Operator regardless of risk level**
- Given a change that touches the deployment's regulated-sensitive paths
- When it is considered for the shared mainline
- Then the compliance lens forces it to the Operator, and no risk level or lane can earn it an autonomous proceed — the compliance decision composes with and overrides this one

**Scenario: A deployment starts fully cautious**
- Given a deployment that has not yet earned autonomy for a given risk level
- When a change of that level is ready — including a green one
- Then it is held for the Operator; nothing proceeds on the platform's judgement until the Operator has granted that deployment autonomy for that level

**Scenario: The Operator earns a deployment more autonomy**
- Given a deployment whose changes of a given risk level have been proceeding correctly under the Operator's review
- When the Operator explicitly grants that deployment autonomy for that level
- Then later changes of that level may follow the autonomous path, and the grant is recorded

**Scenario: An uncertain risk level resolves toward more caution**
- Given a change whose risk level cannot be established with confidence
- When it is considered
- Then it is treated as the more cautious level — never the less cautious one — and when in genuine doubt it reaches the Operator

**Scenario: The Operator decides a held change**
- Given a change held for the Operator, presented with its lane, its risk level, the checks it passed, and any blocking reason
- When the Operator approves it to proceed or sends it back
- Then it proceeds or returns for rework accordingly, and the Operator's decision is recorded

### Lanes — the deployment-configurable path

**Scenario: Every change travels exactly one lane**
- Given a deployment whose profile declares a set of lanes — each lane naming how a change qualifies for it, what changes in it are allowed to touch, who implements and reviews them at which capability level, which checks must pass before merge, how a qualifying change may join the shared mainline, and whether merged changes receive a later batch review
- When a finished change is classified
- Then it is assigned to exactly one lane — the one whose qualification it meets — and the assignment and the reasons for it are recorded

**Scenario: Changing a lane is configuration, not a platform change**
- Given the Operator wants a deployment's changes of some class handled differently — different checks, a different review depth, a different merge treatment
- When they edit that deployment's lane declarations in its profile
- Then later changes follow the new lane policy without any change to the platform itself

**Scenario: A lane configures within the caution floor, never past it**
- Given a lane whose declared policy would, for some change, demand less caution than the change's risk level, the deployment's earned autonomy, or the compliance lens requires
- When such a change is considered for the shared mainline
- Then the risk level, the earned-autonomy state, and the compliance lens prevail — a lane can add caution beyond the floor, but no lane declaration can take caution below it

**Scenario: A lane with a batch-review policy gets its merged changes re-examined**
- Given a lane whose policy includes a later batch review of changes that merged autonomously
- When such changes have merged
- Then they are examined together at the lane's declared cadence, and every finding is routed back as new work or as a decision for the Operator — a finding from the batch review is never silently dropped

### Lifecycle modes — phase-scaled rigor on an invariant floor

**Scenario: A deployment declares its lifecycle phase**
- Given a deployment's profile declares which phase of its life it is in — illustratively: an early phase that favors speed and breadth, a consolidation phase that favors cleanup and tightening, and a released phase that demands clinical rigor
- When the platform handles that deployment's changes
- Then the gate-sets and merge policies its lanes apply may vary by the declared phase, so the same class of change can travel with lighter ceremony before the deployment's first production release and with full rigor after it

**Scenario: A phase transition is an Operator decision, never automatic**
- Given a deployment shows whatever marker might suggest its phase should change — a first production release approaching, a track record accumulating, a hardening effort concluding
- When a phase change is considered
- Then the platform may at most propose it as a decision for the Operator, and the deployment's phase changes only on the Operator's explicit, recorded decision — never by elapsed time, by track record, or by any automatic rule

**Scenario: Every mode keeps every invariant**
- Given a deployment in its most permissive lifecycle phase
- When any of its changes is considered for the shared mainline
- Then the scope verification still runs unweakened, the always-escalate decisions — orange and red levels, compliance-forced changes, and every decision class the platform always routes to a human — still reach the Operator, and a change without passing verification still never proceeds autonomously: a lifecycle phase scales how much rigor a lane applies, it never bypasses an invariant

### The scope verification — never configurable

**Scenario: A change is verified against its lane's declared scope**
- Given a lane declares what changes in it are allowed to touch
- When a change in that lane is considered for the shared mainline
- Then what the change *actually touched* — not what it was expected to touch — is compared against the lane's declared scope

**Scenario: A change that strayed outside its lane is escalated, never quietly allowed**
- Given the scope verification finds a change touched something its lane does not permit
- When the change is considered for the shared mainline
- Then it does not proceed on the platform's judgement: it is moved to a more cautious path or held for the Operator, with the out-of-scope finding recorded and shown

**Scenario: The scope verification cannot be configured away**
- Given any deployment profile and any lane declaration, however permissive
- When a change in any lane that allows an autonomous proceed is considered
- Then the scope verification runs, and no configuration — lane, profile, or otherwise — can disable it, weaken it, or substitute the change's declared intent for what it actually touched

**Scenario: Sensitive-area markings escalate only**
- Given a deployment's profile marks certain areas of its work as higher-risk
- When a change touches a marked area
- Then the marking can only force the change toward a more cautious lane, level, or decision — a marking can never qualify a change for a less cautious path than it would otherwise receive

**Scenario: The safeguard binds the platform's sorting, not the Operator's policy**
- Given the Operator has deliberately declared a permissive lane for a class of changes
- When changes of that class travel it within the lane's declared scope
- Then the scope verification does not second-guess the Operator's policy — it exists to catch the platform sorting a change into the wrong lane, not to narrow what the Operator chose to permit

### Earning a lane in

**Scenario: A lane builds a recorded track record**
- Given changes are flowing through a lane
- When each one merges cleanly or is bounced — by the scope verification, a failed check, or a review block
- Then the lane's per-deployment track record is updated, and the record is visible to the Operator

**Scenario: A lane that meets its earn-in bar is proposed for promotion**
- Given a deployment's profile declares an earn-in bar for a lane — a required track record before that lane may merge autonomously, expressed in the profile, not in the platform — and no pre-approved auto-promotion policy for it
- When the lane's recorded track record meets the bar
- Then the platform surfaces a promotion decision to the Operator, and only the Operator's explicit, recorded grant widens that lane's autonomy

**Scenario: A lane with a pre-approved earn-in policy auto-widens on meeting its bar**
- Given a deployment's profile declares a **pre-approved earn-in policy** for a lane — the Operator's grant given in advance — and the lane is verifier-gated and its risk level is one eligible for an autonomous proceed
- When the lane's recorded track record meets the bar
- Then the lane's autonomy widens without a per-promotion decision, the auto-promotion is recorded with the policy and the track record that triggered it, and it remains reversible fleet-wide

**Scenario: Pre-approved auto-promotion never crosses an always-escalate boundary**
- Given a deployment has declared a pre-approved earn-in policy
- When the policy would widen autonomy for a lane that is not verifier-gated, or for an orange, red, compliance-forced, or otherwise always-escalate class
- Then the auto-promotion does not occur — the pre-approval is inert outside its bounds, and any such widening still requires an explicit, per-event Operator decision

**Scenario: An uncertain or failing track record never promotes**
- Given a lane whose track record is below its earn-in bar, or cannot be established with confidence
- When promotion is considered
- Then no promotion decision is raised and the lane keeps its current, more cautious treatment

### Audit

**Scenario: The decision is auditable**
- Given a change that passed through this decision
- When its history is examined later
- Then it shows the lane it was assigned and why, the risk level it was given, the scope-verification verdict, which checks were required and their verdicts, whether the deployment had earned autonomy for that level and lane, and who or what allowed it to proceed — enough to reconstruct why it joined the shared mainline or was stopped

## Success Criteria

- No change joins the shared mainline on the platform's judgement unless its risk level permits an autonomous proceed, its verification passed, any required independent review passed, the scope verification confirmed it stayed within its lane, the deployment has earned autonomy for that level and lane, and the compliance lens has cleared
- A change whose verification did not pass never proceeds without the Operator, at any risk level or in any lane
- A change touching regulated-sensitive paths never proceeds without the Operator, at any risk level or in any lane
- The red level never proceeds without the Operator, no matter how much autonomy a deployment has earned
- A change that touched anything outside its lane's declared scope never proceeds on the platform's judgement, in any lane, under any configuration
- Every deployment begins with all risk levels held for the Operator and widens only by the Operator's grant — given per promotion, or in advance as a pre-approved earn-in policy bounded to verifier-gated, autonomous-eligible lanes — trust is earned, never granted at the outset, for levels and for lanes alike
- Once a level's or lane's autonomy is earned, routine changes of that class stop reaching the Operator, measurably relieving him of that work
- Reshaping how a deployment's changes are handled — qualification, scope, capability level, checks, merge treatment, batch review, earn-in bar — is an edit to that deployment's profile, never a change to the platform
- Any uncertainty about a change's risk level or lane resolves toward more caution — never green, yellow, or a permissive lane when in genuine doubt — and a classification that cannot be established with confidence reaches the Operator
- Every change carries a record of its lane, its risk level, the lifecycle phase in effect, the scope-verification verdict, the checks it passed, and the decision — sufficient to reconstruct the outcome after the fact
- A deployment's lifecycle phase changes only by an explicit, recorded Operator decision; and no phase, however permissive, disables the scope verification, the always-escalate set, the verification requirement, or the compliance lens

## Constraints

- The **shared mainline** is the single line of work a deployment's releases are drawn from; this decision governs only whether a change may join it, and never itself joins a change, alters another stage of the work, or authors or edits any specification
- **No verification, no autonomous proceed** is inviolable: a change the platform cannot show was verified is never eligible to proceed without the Operator, at any risk level or in any lane
- The **compliance lens composes with and overrides** this decision: where FUNC-AC-COMPLIANCE-GATE requires the Operator, no lane and no risk level can grant an autonomous proceed
- **Lanes are deployment policy**: every value in a lane declaration — qualification, allowed scope, capability levels, check set, merge treatment, batch-review cadence, earn-in bar — is held in the deployment's profile (per FUNC-AC-FLEET) and is never fixed in the platform itself; the platform supplies the mechanism, the profile supplies the values
- The **scope verification is the platform's own and is non-configurable**: it runs against what a change actually touched, for every lane that allows an autonomous proceed, and no profile, lane, or configuration may disable, weaken, or bypass it; it exists to catch the platform's own classification errors, never to constrain what the Operator may deliberately permit
- **Sensitive-area markings in a deployment's profile escalate only**: they may force a change to a more cautious lane, level, or decision, and may never qualify it for a less cautious one
- Autonomy for a risk level or a lane is a **per-deployment, earned** property held in the deployment's profile; it is never on by default, and it widens only by the Operator's decision — given either per promotion (the default: meeting an earn-in bar raises a promotion decision) or **in advance** as a pre-approved earn-in policy that auto-widens the lane on meeting its bar. Pre-approved auto-promotion is bounded and non-relaxable: it applies only to a **verifier-gated** lane and only to risk levels eligible for an autonomous proceed — never orange, red, compliance-forced, or any always-escalate class — and every auto-promotion is recorded and remains reversible fleet-wide (demote-on-red, per FUNC-AC-FLEET)
- The decision is **fail-safe**: any uncertainty — an unestablished risk level, an unassignable lane, an indeterminate scope verdict, a missing or indeterminate check, an unavailable reviewer — resolves to the more cautious treatment or to holding the change for the Operator, never to letting it proceed
- **Lifecycle phases are configuration on an invariant floor**: which phases exist, what each phase means for a lane's gate-set and merge policy, and which phase a deployment is in are deployment policy held in its profile, never fixed in the platform; a phase transition is always an Operator decision surfaced as a decision request, never automatic; and no phase declaration can weaken the scope verification, the always-escalate set, the verification requirement, or the compliance lens — a mode scales rigor within the invariants, never past them
- A change's risk level is judged by its effect on the shared mainline in plain terms — how far it reaches, whether it touches sensitive or hard-to-reverse areas, how large it is — not by any single fixed measure
- A **batch-review finding is never terminal silence**: every finding from a lane's post-merge batch review ends as new work, a decision, or a recorded dismissal — never dropped
- The lane assignment, the risk level, the scope-verification verdict, the required checks and their verdicts, and the final decision are durably recorded before a change is allowed to proceed
