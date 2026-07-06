---
id: FUNC-AC-RELEASE
type: functional
domain: runforge
status: approved
version: 2
layer: 1
---

# FUNC-AC-RELEASE — Operator-Approved Production Release

> **Operator-approved 2026-07-03 (Decision D2 of the first-production-deployment program plan).** This v2 content was ratified via the Operator specification-content gate. L2/L3 remain draft until the Phase-9 live proof.
>
> **Spec history (v2, 2026-07-02):** v1 (approved) governed the release of the platform's own running instance only. v2 generalizes release to **every deployment**: a release proposal aggregates a deployment's accepted-but-unreleased work; it **always** raises the Operator's reserved production-release decision and never earns autonomy, no matter how much merge autonomy the deployment has accrued; and on the Operator's approval it carries out that deployment's **declared production-release path** — which may range from the platform performing the whole promotion itself, to marking the approved release and triggering the deployment's automated production update, to only recording the approved release for a human procedure to complete. Every proposal and every execution is appended to an auditable per-deployment release ledger. All v1 guarantees — preview before change, approval-only, fail-safe on a failed release, and a durable record — are carried forward unchanged. Extending the content re-opens the Operator's specification-content gate, so status returns to `draft` pending his approval.

## Problem Statement

Accepted, verified work accumulates as a deployment's canonical, ready state, but what is actually running in that deployment's production only changes when someone deliberately promotes it. Today there is no controlled, recorded way to make that promotion for a deployment and no gate reserving it for the Operator. Without one, production can drift from the ready state with no one certain what is live; a release could happen without the Operator's decision; or a release could leave production half-changed after a failure. The Operator needs to decide every production release, to see exactly what a release would change before committing to it, and to have each release recorded — so production never advances without his say, a release can be previewed safely first, and what is live is always knowable.

Deployments do not all promote to production the same way. For one deployment the platform can carry out the whole promotion itself; for another it triggers the deployment's own automated update; for a third — a regulated one — the platform may change nothing in production directly and instead produce an audited release record that a human completes by a documented procedure. Whichever shape a deployment declares, the gate, the preview, the approval, and the record are identical: a production release is always the Operator's per-event decision, and every proposal and execution belongs to an auditable trail for that deployment.

## Actors

- **Operator** — the human who previews, approves, and triggers each production release, and who completes a release that his deployment declares as a human procedure.
- **Control Plane** — assembles a deployment's release proposal from its accepted-but-unreleased work, raises the reserved production-release decision, carries out the deployment's declared release path on approval, and appends every proposal and execution to that deployment's release ledger.

## Behavior

### The reserved gate — carried from v1

**Scenario: Preview a release before anything changes**
- Given a deployment has accepted, verified work ready to release
- When the Operator asks to preview a release for that deployment
- Then they are shown what has been accepted since that deployment's last release and what releasing would change, and nothing in production is altered

**Scenario: Production changes only on the Operator's approval**
- Given a release has been previewed
- When the Operator approves the release
- Then the deployment's production is advanced to the approved set of work, and the release is recorded

**Scenario: Nothing is released without approval**
- Given any amount of accepted, verified work
- When the Operator has not approved a release
- Then production does not change, no matter how the work qualified or how confident the platform is

**Scenario: A failed release leaves production as it was**
- Given a release is under way that changes production
- When any step of it fails
- Then production is left exactly as it was before the release and the failure is surfaced to the Operator, rather than production being left partly changed

**Scenario: Every release is recorded**
- Given the Operator approves a release
- When the release completes
- Then it is recorded with what was released and when, so what is live can always be known

### Per-deployment release lanes — v2

**Scenario: A release proposal aggregates one deployment's unreleased work**
- Given a deployment whose accepted, verified work has landed on its trunk since its last release
- When a release is proposed for that deployment
- Then the proposal gathers exactly that deployment's accepted-but-unreleased work, and each deployment's release is proposed and decided on its own

**Scenario: A production release always reaches the Operator and never earns autonomy**
- Given a deployment that has earned wide autonomy for its ordinary work, up to and including changes joining its trunk without the Operator
- When a release is proposed for that deployment
- Then the release still raises a production-release decision for the Operator, and it never proceeds on the platform's judgement, no matter how much autonomy the deployment has earned or pre-approved

**Scenario: On approval the platform carries out the deployment's declared release path**
- Given a deployment's profile declares how its releases are carried out
- When the Operator approves a release for that deployment
- Then the platform carries out that declared path — performing the promotion itself, or triggering the deployment's automated production update, or handing off to the deployment's human procedure — and records the result

**Scenario: A record-only release changes nothing in production directly**
- Given a deployment whose declared release path is to record the approved release for a human procedure to complete
- When the Operator approves a release for that deployment
- Then the platform produces the audited release record and hands off to the deployment's documented procedure, changing nothing in production itself, and the record shows the release awaits its human step

**Scenario: A deployment's releases are auditable end to end**
- Given a deployment has had releases proposed and decided
- When its release history is examined later
- Then the deployment's release ledger shows each proposal, the work it covered, the Operator's decision, and the outcome of carrying out the declared path — enough to know what was released, when, and how

## Success Criteria

- No deployment's production advances without the Operator's per-release approval
- A production release never proceeds on the platform's judgement, at any level of earned or pre-approved autonomy — it is always the Operator's per-event decision
- The Operator can preview exactly what a release would change for a deployment before approving it, with no effect on production
- Each deployment's release proposal covers exactly that deployment's accepted-but-unreleased work, and releases are decided per deployment
- On approval, the platform carries out the deployment's declared release path — whether it performs the promotion, triggers the deployment's automated update, or only records the release for a human procedure
- A failed release that changes production never leaves it partly changed — the previously-live state remains intact
- Every proposal and every execution is appended to an auditable per-deployment release ledger, so what is live for each deployment is always knowable

## Constraints

- A production release is always a per-event Operator approval — never automatic and never pre-approved, no matter how the work qualified or how high its earned trust (this enacts the L0 boundary that production is never deployed without the Operator's per-event approval, and it holds for every deployment regardless of the autonomy it has earned for its ordinary work)
- A release is always scoped to a single deployment: its proposal aggregates only that deployment's accepted-but-unreleased work, and it is previewed, approved, and recorded per deployment
- A release must be previewable before it is approved, and the preview must never alter what is running
- The way a release is carried out is declared in the deployment's profile; the platform supplies the mechanism for each declared shape — performing the promotion, triggering the deployment's automated update, or recording the approved release for a human procedure — while the shape a given deployment uses is its own declaration
- A failed or interrupted release that changes production must leave the previously-live state intact — production is never left half-promoted; a record-only release changes nothing in production and instead leaves an audited record awaiting its human step
- Every release proposal and every execution result must be appended to an auditable per-deployment release ledger, recording what was covered, the Operator's decision, and the outcome
