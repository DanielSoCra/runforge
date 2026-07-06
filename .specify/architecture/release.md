---
id: ARCH-AC-RELEASE
type: architecture
domain: runforge
status: draft
version: 2
layer: 2
references: FUNC-AC-RELEASE
---

# ARCH-AC-RELEASE — Operator-Approved Production Release

## Overview

Each deployment gets its own **release lane**. On the Operator's request the **Control Plane** assembles a per-deployment **Release Proposal** — the deployment's accepted-but-unreleased work since its last recorded release — renders it as a **preview** that changes nothing in production, and raises the reserved **production-release decision** to the Operator. This decision is always raised for every release and never resolves on the platform's judgement, no matter how much autonomy the deployment has earned for its ordinary work. On the Operator's approval the Control Plane carries out that deployment's **declared release path** — one of three shapes: the platform performs the promotion itself, the platform triggers the deployment's own automated production update, or the platform records the approved release for a human procedure and changes nothing in production. Every proposal, decision, and execution outcome is appended to that deployment's append-only **Release Ledger**, the source of truth for what is live.

## Data Model

A **Release Proposal** belongs to one deployment. It records the target revision to release to, the set of accepted-but-unreleased work it covers (the work that landed on that deployment's trunk since its last release), a human-readable summary of what releasing would change, and the declared release path shape that would carry it out. A proposal is a preview artifact: describing or raising it never changes production.

A **Release Ledger** belongs to one deployment and is an append-only log of **Release Events**. A single release is identified by a release id and progresses through events appended in order: a **proposal** event (the proposal it concerns), a **decision** event (the Operator's answer — approved or rejected, and, offered until the deployment has its first *approved* production release, whether its debut into pre-approved unattended merging may begin — the debut-authorization flag defined by ARCH-AC-EARN-IN, carried only by an approved decision and read back by the earn-in debut gate, folded into this approval rather than raised as a separate beat), and, for an approved release, an **execution** event recording the outcome of carrying out the declared path — *released* (production advanced and confirmed live), *triggered-awaiting* (the deployment's automation was triggered), *recorded-awaiting-human* (a record-only release handed off to a human procedure), or *failed* (a production-mutating release that failed, with the prior state left intact). The two handed-off outcomes (*triggered-awaiting*, *recorded-awaiting-human*) are non-final: a later **completion** event resolves such a release to *released* or *failed* once the deployment's automation or human procedure reports back. The log is never rewritten and, read end to end for a release id, shows that release's proposal, decision, and outcome — the source of truth for what is live for that deployment.

A **Last-Released Marker** for a deployment is the target revision of its most recent *released* event — whether that came directly from a platform-performs execution or from a completion event confirming an automated or human-completed release. It is derived from the ledger, not stored separately, so there is one source of truth; it is the diff base a proposal aggregates from.

A **Declared Release Path** is part of a deployment's profile and is exactly one of three shapes: **platform-performs** (the platform's built-in promotion mechanism advances and restarts the running system, with a fail-safe that restores the prior state on failure), **trigger-automated** (the platform triggers the deployment's own automated production update at a declared target and records that it was triggered), or **record-only** (the platform mutates nothing in production and writes an audited record for a documented human procedure to complete).

The **Running Production System** for a deployment is its live instance. It is changed only by an approved platform-performs or trigger-automated execution; a preview and a record-only release never change it.

The **Ready Trunk** is the deployment's canonical accepted-and-verified line of work a release promotes from. The release lane only reads it, never alters it.

## API Contract

- **previewRelease(deployment)** — Operator-triggered on the Control Plane. Reads the deployment's Last-Released Marker from its Release Ledger, diffs its Ready Trunk since that marker, and assembles a Release Proposal. Returns the proposal (covered work, target revision, summary, declared path shape). Mutates nothing in the Running Production System. Outcome: the preview, or *nothing-to-release* when no accepted work has landed since the last release.
- **proposeRelease(deployment)** — Operator-triggered. Assembles the proposal, appends a proposal event to the deployment's Release Ledger, and raises the reserved production-release decision (approve/reject) to the Operator through the existing Decision Ledger. Always raises; it never resolves on earned or pre-approved autonomy. Outcome: a pending Operator decision.
- **resolveRelease(deployment, approval)** — Applied when the Operator answers the raised decision. Appends a decision event. On **reject**, production is untouched. On **approve**, carries out the deployment's Declared Release Path and appends an execution event. Outcome: *released*, *triggered-awaiting*, *recorded-awaiting-human*, or *failed* (prior state intact).
- **recordCompletion(deployment, release, outcome)** — Applied when a handed-off release (a *triggered-awaiting* or *recorded-awaiting-human* one) reports back. Appends a completion event resolving that release to *released* — advancing the Last-Released Marker — or to *failed*. Only the two non-final outcomes can be completed; a *released* or *failed* release is already terminal.
- There is no autonomous release path: production advances for a deployment only through an Operator-approved `resolveRelease`, and the decision behind it is always raised.

## System Boundaries

The **Control Plane** owns the release lane: it assembles proposals, raises the reserved decision, carries out the declared release path on approval, and is the sole writer of every Release Ledger. It never advances a Running Production System except through an approved execution.

The **Release Ledger** is append-only and per-deployment; it is the source of truth for what is live and for the Last-Released Marker, and it is never rewritten. If it is unavailable, the Control Plane refuses to execute a release, because a release that cannot be recorded would make the live state unknowable.

The **Decision Ledger** is the existing Operator-decision transport; the release lane reuses it to raise, publish, and mark the reserved production-release decision. The release decision is distinguished by its release phase and its approve/reject options; the lane adds no new decision transport.

The **Deployment Registry** owns each deployment's profile, including its Declared Release Path. The release lane reads the declared shape; it never invents or overrides it. A deployment whose declared path is missing or malformed fails closed — no release is carried out.

The **Running Production System** for a deployment is changed only by an approved platform-performs or trigger-automated execution. A preview never touches it, and a record-only release never touches it. Under platform-performs, the deployment's supervisor keeps the prior instance running until a promotion is confirmed.

The **Ready Trunk** is read-only to the release lane — a release promotes from it and never alters it.

## Event Flows

1. The Operator previews a release for deployment **D**. The Control Plane reads D's Last-Released Marker from D's Release Ledger, diffs D's Ready Trunk since that marker, assembles the proposal, and renders it. Nothing in production is recorded or changed. If nothing has landed since the last release, the preview reports *nothing-to-release*.
2. The Operator proposes the release. The Control Plane appends a proposal event to D's Release Ledger and raises the reserved production-release decision for D through the Decision Ledger — always, regardless of the autonomy D has earned for its ordinary work — then publishes and marks it and waits for the Operator.
3. The Operator **rejects**. The Control Plane appends a decision event (rejected) to D's ledger. Production is unchanged.
4. The Operator **approves**. The Control Plane appends a decision event (approved) and carries out D's Declared Release Path, then appends an execution event:
   - **platform-performs** — the platform advances D's Running Production System to the target revision and confirms it is live; on any failure it restores the prior-live state; it appends *released* on success or *failed* on failure.
   - **trigger-automated** — the platform triggers D's own automated production update at the declared target and appends *triggered-awaiting*; if the trigger cannot be fired, nothing is promoted and it appends *failed*.
   - **record-only** — the platform changes nothing in production, appends *recorded-awaiting-human*, and hands off to D's documented procedure.
5. For a handed-off release (*triggered-awaiting* or *recorded-awaiting-human*), when D's automation or human procedure reports back the Control Plane appends a completion event resolving it to *released* or *failed*.
6. On any *released* event — whether a platform-performs execution or a completion — D's Last-Released Marker advances to the released revision (derived from that event); the ledger now shows the full trail — proposal, decision, execution, and any completion — for that release.

## Error Handling

- **Nothing to release** — when no accepted work has landed since D's Last-Released Marker, the preview reports *nothing-to-release* and no decision is raised; production is untouched.
- **Missing or malformed Declared Release Path** — the Control Plane refuses to execute and surfaces why; no production change is made and no *released* event is appended (fail closed, mirroring how a missing landing target escalates rather than guesses).
- **Approved platform-performs execution fails** — the prior-live instance is restored by the deployment's supervisor, the failure is surfaced, and the ledger appends an execution event of *failed* with the prior state intact; production is never left half-promoted, and nothing is recorded as *released*.
- **Approved trigger-automated cannot fire** — nothing is promoted, the failure is surfaced, and the ledger appends a terminal execution event of *failed*; no completion follows and what is live is unchanged. (A trigger that *does* fire appends the non-final *triggered-awaiting*, whose later completion event reflects the automation's outcome.)
- **A handed-off release reports failure** — when a *triggered-awaiting* or *recorded-awaiting-human* release comes back failed, the ledger appends a completion event of *failed* and the Last-Released Marker does not advance; what is live is unchanged from before that release.
- **Release Ledger unavailable** — the Control Plane refuses to carry out any release, since a release it cannot record would make the live state unknowable.
- **Decision transport degraded** — the release fails closed: without a recorded, published production-release decision the release does not proceed, and the deployment is marked degraded rather than releasing on partial state.
- **Autonomy bypass attempt** — there is no code path that resolves the production-release decision on the platform's judgement; it is always raised and only an Operator answer resolves it, at any level of earned or pre-approved autonomy.
