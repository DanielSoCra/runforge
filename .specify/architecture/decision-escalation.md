---
id: ARCH-AC-DECISION-ESCALATION
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-DECISION-ESCALATION
---

# ARCH-AC-DECISION-ESCALATION — Structured Decision Escalation

## Overview

The Control Plane turns every run pause that needs a human choice into a uniform, durable **DecisionRequest** held in a **Decision Store**, surfaces its shared form to the Operator through the Steering Surface, and — on a recorded answer — continues or restarts the exact run that was waiting. A lifecycle state machine, a single-writer claim, and an idempotent, crash-safe answer-and-resume path together guarantee that each request is answered exactly once, never silently lost, and never resumed before its answer is durably recorded. Inbound content is sanitized at ingest by the Sanitization Pipeline (**ARCH-AC-SANITIZATION**) before any record is written; with no Sanitizer configured — the default — content is persisted as provided and the Decision Store is content-agnostic, and where a deployment configures a withholding Sanitizer the withheld original is held apart in the Redaction Store and revealed only to the authorized Operator, so it never reaches the shared item, its notifications, or run history.

## Data Model

A **DecisionRequest** belongs to one Worker run and one deployment. It records: the question; a concise context slice; an ordered set of **Choices**; which Choice is recommended; the consequence of leaving it unanswered; how reversible the decision is; a deadline; its lifecycle state; the identity and generation of the run that owns it; and the times it was raised, answered, and resolved.

A **Choice** has a human-readable label and a stable identifier. An answer is valid only if it names one of a request's Choices.

A **DecisionResponse** belongs to one DecisionRequest. It records the chosen Choice, an idempotency key, who answered, and when. At most one DecisionResponse is ever effective for a request; the first valid one wins and later ones change nothing.

Any confidential content a configured Sanitizer withholds from a request is held as a **WithheldValue** in the Redaction Store defined by **ARCH-AC-SANITIZATION** — apart from the shared request and revealed only to the authorized Operator. With no Sanitizer configured, a request carries no withheld content and the Decision Store holds it verbatim.

A DecisionRequest moves through a defined **lifecycle**: *detected* → *notified* → *viewed* → *answered* → *resolved*, where *resolved* is reached by either *resumed* (the original run continued) or *restarted* (the work was begun again with the answer carried in). Three terminal or interrupting states branch off any open state: *withdrawn* (the question became moot), *overdue* (the deadline lapsed unanswered), and *failed* (the request could not be completed). A *legacy* free-form pause is converted once into a *detected* DecisionRequest. Only the transitions named in Event Flows are permitted; any other transition is rejected.

An **AppliedTransition** record marks each lifecycle transition the Control Plane has durably committed for a request, so that a replay after an interruption recognises an already-applied step and repeats no effect.

## API Contract

These are the operations between the Worker, the Control Plane, the Decision Store, and the Steering Surface. Each returns an explicit outcome; nothing partially applies.

- **raise(runRef, request)** — the Worker asks the Control Plane to create a DecisionRequest for a paused run, supplying the question, context slice, Choices, recommended Choice, consequence-of-no-answer, reversibility, and deadline. Idempotent on the run and its pause point: a repeat returns the existing request rather than creating a second. Outcome: the request identity in its shared form, or *rejected* if the run is not in a pausable state.

- **list(filter)** — the Steering Surface reads open DecisionRequests across deployments in their **shared form only** (never withheld content), with enough of each to read, prioritise, and route it without opening the run. Outcome: the matching requests.

- **reveal** — revealing any withheld content is provided by **ARCH-AC-SANITIZATION** (the Redaction Store reveal), keyed by a request's withholding references and exposed only to the authorized Operator. This spec defines no separate reveal.

- **answer(requestId, choiceId, idempotencyKey, operator)** — submits the Operator's choice. The Control Plane accepts it only if the request is open and the choice names one of its Choices, recording one DecisionResponse. Outcome: *accepted*; or *rejected* with a reason — *not-a-choice*, *already-answered*, or *withdrawn*.

- **withdraw(requestId, reason)** — marks a request moot so the Operator is not asked to decide it. Outcome: *withdrawn*, or *not-found*.

- **reconcile()** — re-derives request and run state from the Decision Store and the AppliedTransition records and completes any answer whose resume or restart did not finish, exactly once. Outcome: the set of requests it advanced. This is the recovery path after any interruption.

## System Boundaries

The **Control Plane** owns run state and is the **single writer** of DecisionRequest lifecycle transitions. Before transitioning a request it claims the owning run by matching the run's identity and generation; a writer whose generation is stale is refused, so two actors never transition the same request.

The **Decision Store** is the durable source of truth for DecisionRequests, DecisionResponses, and AppliedTransition records. It survives daemon restarts; state is always re-derivable from it.

Inbound content is sanitized at the single ingest seam by the Sanitization Pipeline (**ARCH-AC-SANITIZATION**) before the Control Plane writes any record; the **Decision Store** persists exactly what the pipeline returns and is content-agnostic. Any content a configured Sanitizer withholds lives in the Redaction Store owned by that spec — never in the Decision Store, notifications, or run history.

The **Steering Surface** — the single cross-deployment decision inbox defined in FUNC-AC-FLEET — reads requests in shared form and submits answers. It does not mutate run state directly: an answer is intake that the Control Plane validates and applies.

The **Notifier** emits notifications derived from request state. It reads only the shared form, so a notification can never leak withheld content.

A Worker reads no decision state directly; it raises a request and then waits to be continued or restarted by the Control Plane.

**Decision Store as the required escalation transport for a merge-governed deployment (first-use safety).** A deployment that activates merge governance — one configured with a deployment profile — cannot satisfy *"no decision request is silently lost"* when the Decision Store is unavailable: an escalate/hold/compliance merge decision would then have no durable transport to the Operator. The Control Plane therefore treats an **available** Decision Store as a **boot prerequisite** for such a deployment. At startup, if the deployment profile is rejected at registration, **or** the Decision Store is unavailable — distinguishing *disabled* (the index flag is off) from *enabled-but-unreachable* (its backing store cannot be reached) — the daemon **refuses to boot** and reports the underlying cause in operator-readable form, rather than starting blind and converting every required park into a silent runtime failure. A deployment with no profile is unaffected: the Decision Store stays optional and a disabled index is normal. Because the prerequisite only guarantees availability *at boot*, a merge-governed deployment whose Decision Store fails *after* boot — any failure of an approval-path transition (raise, notify, answer, advance-to-resumed, or the periodic reconcile/overdue sweep) — is marked **runtime-degraded**; the existing fail-closed flow (the run stays parked, never advances on unconfirmed state) is unchanged, and the marker is cleared only by a subsequent successful **decision-store transition** that proves the transport recovered (a fresh raise+notify, or an advance-to-resumed) — never by a downstream Git merge, which does not touch the store — so the degraded state stays observable through the system's observability surface until the transport itself recovers.

## Event Flows

1. A Worker run reaches a point it cannot pass and calls **raise** with the question, context slice, Choices, recommendation, consequence, reversibility, and deadline.
2. The Control Plane runs the inbound content through the Sanitization Pipeline (none by default), writes the request — as the pipeline returned it — to the Decision Store in *detected*, records the transition, and the run parks.
3. The Notifier surfaces the request to the Steering Surface; state moves to *notified*. When the Operator opens it, state moves to *viewed*.
4. The Operator submits a choice via **answer**. The Control Plane confirms the request is open and the choice matches an offered Choice, records one DecisionResponse keyed by the idempotency key, and moves state to *answered*. A second submission finds the request already answered and changes nothing.
5. The Control Plane claims the owning run by identity and generation and continues it from the pause with the chosen answer; on success it records the transition and moves state to *resumed*.
6. If the run can no longer continue where it left off, the Control Plane starts the work again with the answer carried in, tells the Operator the earlier partial work may repeat, and moves state to *restarted*.
7. If a deadline lapses with no answer, state moves to *overdue*: the request is brought back to the Operator rather than dropped, and its stated no-answer consequence takes hold.
8. If the work is cancelled or the question no longer applies, **withdraw** moves state to *withdrawn*.
9. When a legacy free-form pause is detected, the Control Plane converts it once into a *detected* DecisionRequest so it can be read and answered like the rest.

## Error Handling

- **Interruption between recording the answer and resuming.** On restart, **reconcile** reads the Decision Store and the AppliedTransition records and completes the resume or restart exactly once; the durable answer is authoritative and the resume is replay-safe. No run continues or repeats work before its answer is durably recorded.
- **Duplicate or conflicting answers.** The first valid DecisionResponse is effective; any later answer — same or different choice, from any surface — is rejected as *already-answered* and has no effect.
- **Answer that names no offered Choice.** Rejected as *not-a-choice*; the request stays open and the Operator may answer again.
- **Decision Store unavailable.** Raising fails safe — the run stays parked and the pause is never lost — and answering is refused rather than half-applied; nothing advances on unconfirmed state.
- **A configured Sanitizer fails.** Per ARCH-AC-SANITIZATION the request is not persisted and the run stays parked with the failure surfaced for retry, rather than risk persisting unsanitized content; the pause is never lost. With no Sanitizer configured this case does not arise.
- **Resume target gone.** When the run is unrecoverable, the Control Plane falls back to restart-with-answer and flags that partial work may repeat.
- **Contended transition.** A writer whose run generation is stale is refused by the claim; only the current owner advances the request, so concurrent attempts cannot double-apply.
- **Deadline with no answer.** The request is marked *overdue* and re-surfaced; it is never silently dropped, and it ends only as answered, withdrawn, or overdue-and-re-surfaced.
