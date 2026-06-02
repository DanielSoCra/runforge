---
id: FUNC-AC-MERGE-DECISION
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-MERGE-DECISION — Earned-Trust Merge Decision

## Problem Statement

The platform finishes many changes on its own, and each one meets a single decision before it joins the deployment's shared mainline: may it proceed on the platform's judgement, or must it wait for the Operator? Getting this wrong in one direction starves the Operator of leverage — the platform produces work but never relieves him, which defeats its purpose. Getting it wrong in the other lets a change that deserved a human's eyes slide in unattended.

Today the platform can tell whether a change touched a regulated-sensitive path, and it holds a principle that autonomy is earned per deployment — but it has nowhere that decides, for an ordinary change, how risky it is and what that risk earns. The result is all-or-nothing: either everything is escalated to the Operator, or trust is granted wholesale. What is missing is a graduated, by-construction decision that sorts each change by how much it could harm the shared mainline, lets the safest changes proceed on proof alone, requires an independent check for slightly riskier ones, reserves the Operator's attention for changes that genuinely need it, and starts every deployment fully cautious — widening only as trust is earned. This decision is the engine of earned trust; without it the platform cannot safely take routine work off the Operator's plate, which is the whole point of building it.

## Actors

- **Operator** — the human who decides any change the platform holds for them, and who explicitly grants a deployment the autonomy to handle a given risk level on its own
- **Control Plane** — sorts each completed change by its risk to the shared mainline, requires the checks that risk level demands, holds the change until they pass, and either lets it proceed or routes it to the Operator as a decision
- **Reviewer** — the platform's independent, heterogeneous quality review (the never-self-certifying review owned by FUNC-AC-QUALITY), performed by the platform rather than the Operator, that returns a clear pass-or-block verdict; required for the yellow risk level before a change may proceed without the Operator. This is distinct from the **Compliance Reviewer** below — one judges quality, the other the regulatory lens
- **Compliance Reviewer** — the deployment's regulatory lens, defined in FUNC-AC-COMPLIANCE-GATE, whose verdict composes with and can override this decision
- **Worker** — the autonomous run that produced the change and is waiting on the decision; it cannot send a change to the shared mainline until the decision clears it

## Behavior

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
- Then it never proceeds on the platform's judgement and is held for the Operator, whatever its risk level

**Scenario: A regulated-sensitive change is forced to the Operator regardless of risk level**
- Given a change that touches the deployment's regulated-sensitive paths
- When it is considered for the shared mainline
- Then the compliance lens forces it to the Operator, and no risk level can earn it an autonomous proceed — the compliance decision composes with and overrides this one

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
- Given a change held for the Operator, presented with its risk level, the checks it passed, and any blocking reason
- When the Operator approves it to proceed or sends it back
- Then it proceeds or returns for rework accordingly, and the Operator's decision is recorded

**Scenario: The decision is auditable**
- Given a change that passed through this decision
- When its history is examined later
- Then it shows the risk level it was given, which checks were required and their verdicts, whether the deployment had earned autonomy for that level, and who or what allowed it to proceed — enough to reconstruct why it joined the shared mainline or was stopped

## Success Criteria

- No change joins the shared mainline on the platform's judgement unless its risk level permits an autonomous proceed, its verification passed, any required independent review passed, the deployment has earned autonomy for that level, and the compliance lens has cleared
- A change whose verification did not pass never proceeds without the Operator, at any risk level
- A change touching regulated-sensitive paths never proceeds without the Operator, at any risk level
- The red level never proceeds without the Operator, no matter how much autonomy a deployment has earned
- Every deployment begins with all risk levels held for the Operator and widens only by an explicit, recorded Operator grant — trust is earned, never granted at the outset
- Once a level's autonomy is earned, routine changes of that level stop reaching the Operator, measurably relieving him of that class of work
- Any uncertainty about a change's risk level resolves toward more caution — never green or yellow when in genuine doubt — and a level that cannot be established with confidence reaches the Operator
- Every change carries a record of its risk level, the checks it passed, and the decision — sufficient to reconstruct the outcome after the fact

## Constraints

- The **shared mainline** is the single line of work a deployment's releases are drawn from; this decision governs only whether a change may join it, and never itself joins a change, alters another stage of the work, or authors or edits any specification
- **No verification, no autonomous proceed** is inviolable: a change the platform cannot show was verified is never eligible to proceed without the Operator, at any risk level
- The **compliance lens composes with and overrides** this decision: where FUNC-AC-COMPLIANCE-GATE requires the Operator, this decision can never grant an autonomous proceed
- Autonomy for a risk level is a **per-deployment, earned** property held in the deployment's profile (per FUNC-AC-FLEET); it is never on by default and widens only by an explicit, recorded Operator decision
- The decision is **fail-safe**: any uncertainty — an unestablished risk level, a missing or indeterminate check, an unavailable reviewer — resolves to holding the change for the Operator, never to letting it proceed
- A change's risk level is judged by its effect on the shared mainline in plain terms — how far it reaches, whether it touches sensitive or hard-to-reverse areas, how large it is — not by any single fixed measure
- The risk level, the required checks and their verdicts, and the final decision are durably recorded before a change is allowed to proceed
