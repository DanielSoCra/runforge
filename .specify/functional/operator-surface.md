---
id: FUNC-AC-OPERATOR-SURFACE
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-OPERATOR-SURFACE — Single Operator Surface

> **Spec history (v1, 2026-06-11):** Written for the v-next masterplan (the single-interface goal; decisions D3/D4 and phase P4). This spec owns the Operator's *steering* surface — the minimal inbox, per-run drill-down, and the absorption of the external steering cockpit. FUNC-AC-DASHBOARD continues to own the management surface (repositories, credentials, team, daemon control, cost pages); FUNC-AC-FLEET owns the inbox's focus and ranking semantics; FUNC-AC-DECISION-ESCALATION owns the decision and steering transport this surface fronts. The cockpit fold is deliberately sequenced behind the platform's configured stability bar — the bar's confirmed initial value is recorded in the non-normative default configuration pack example.
>
> **Spec history (v1.1, 2026-06-11, alignment interview):** Three Operator corrections. **Mobile** is a requirement, not a nice-to-have: steering on the go — inbox, briefing, decisions, run controls — must be fully usable from a mobile device. **Both batching and break-through**: routine items hold to the daily batch rhythm, while urgent items surface on demand between batches. **Outcome-first trust**: the Operator trusts the platform by its outcomes — *"Results matter, not the way of getting there"* — so QA results and spot-checkable changes are first-class on the surface and outrank live execution detail in its hierarchy.

## Problem Statement

The platform's purpose is that one person steers many autonomous systems with their attention intact — yet today that person steers through a zoo: a dashboard for some state, a separate steering cockpit for decisions, terminal sessions for watching runs, and the work tracker for everything else. Every tool shows a different slice, no tool shows the whole, and the Operator pays a context-switch tax dozens of times a day. Worse, the richest view of what a run is actually doing — the work it has produced so far — is locked inside the run's working area, so the Operator either trusts a phase label or opens a terminal to look.

The vision already names the cure: one calm pane. What is missing functionally is threefold. First, a **minimal default surface** that shows exactly two things — the decisions waiting on the Operator and the daily briefing — and nothing else, because every additional element on the default view is attention spent on work the system should carry. Second, a **per-run drill-down** for when the Operator wants depth on one run: what it has actually changed so far (live, derived from the run's real produced work — never reconstructed by reading the run's conversation), where it stands, what it has cost, and the steering controls to guide it. Third, the **absorption of the separate steering cockpit** into this one surface — sequenced deliberately *after* the platform has proven stable, and cut over only once the folded surface demonstrably behaves the same as the tool it replaces, because breaking the Operator's steering tools while he depends on them is the one way this consolidation can do net harm.

## Actors

- **Operator** — steers the fleet from the single surface: answers decisions, reads the briefing, drills into runs, and sends notes and run controls
- **Control Plane** — keeps the surface truthful: feeds it decisions and briefings, derives each run's live work state from the run's actual produced work, and carries the Operator's steering actions back to the runs they address

## Behavior

### The minimal inbox — the default surface

**Scenario: The default view shows decisions and the briefing, nothing else**
- Given the Operator opens the surface
- When the default view loads
- Then it shows the decisions waiting on him (per the cross-deployment inbox's focus and ranking rules) and the daily briefing — and no run lists, activity feeds, metrics, or other elements unless the Operator deliberately navigates to them

**Scenario: An empty inbox says so calmly**
- Given nothing currently needs the Operator
- When he opens the surface
- Then it states plainly that nothing waits on him, with the briefing available — an empty inbox is the success state, not a gap to fill

**Scenario: Answering a decision never requires leaving the surface**
- Given a decision is shown in the inbox
- When the Operator answers it
- Then the answer takes effect through the platform's decision handling, with no other tool, page, or session required

**Scenario: The surface steers from the Operator's phone**
- Given the Operator is away from his desk
- When he opens the surface on a mobile device
- Then the steering loop is fully usable there — reading the inbox and briefing, answering decisions, drilling into a run, sending notes and run controls — with nothing reserved for a desktop screen; steering on the go is part of this surface's contract, not a degraded extra

**Scenario: Urgent items break through between batches**
- Given routine items hold to the daily briefing's batch rhythm
- When an item arises between batches that meets the Operator's interruption threshold (per the fleet's focus rules)
- Then it is surfaced to the Operator on demand, immediately, rather than waiting for the next batch — the surface both batches the routine and breaks through with the urgent, and nothing below the threshold interrupts

### Per-run drill-down

**Scenario: The Operator drills into one run**
- Given the Operator wants depth on a specific run
- When he opens its drill-down
- Then he sees, in one place: what the run has actually changed so far, which phase it is in and which it has passed, what it has cost against its budget, the lane and risk treatment it is under, and any decisions or notes attached to it

**Scenario: The work view is live and derived from real work**
- Given a run is producing work in its isolated working area
- When the Operator views its drill-down
- Then the view of what has changed reflects the run's actual produced work as it currently stands — kept current without the Operator refreshing or asking — and is derived from that work itself, never inferred from the run's conversation or self-reports

**Scenario: Steering happens from the drill-down**
- Given the Operator is viewing a run's drill-down and wants to intervene
- When he sends a note or uses a run control (pause, redirect, abort)
- Then the action travels through the platform's steering behavior (per FUNC-AC-DECISION-ESCALATION) directly from this surface, and its acceptance or return is shown where he issued it

### Outcome-first trust — QA results and spot-checks

**Scenario: QA results are first-class wherever work is shown**
- Given the Operator's trust rests on outcomes, not on watching the platform work
- When he views a run, a merged change, or the briefing
- Then the quality-assurance results — which checks ran and passed, what the independent review concluded, what the scope verification found — are presented first-class, ahead of execution detail such as phase narration or session activity

**Scenario: Any change can be spot-checked in one step**
- Given the Operator samples the platform's work rather than reviewing all of it
- When he picks any merged or pending change from the surface
- Then a single step takes him to a spot-checkable view of the change itself — what it actually altered, and the checks, review verdicts, and lane treatment that cleared it — sufficient to judge the outcome without reconstructing the run that produced it

### Folding the steering cockpit in

**Scenario: The fold waits for proven stability**
- Given the separate steering cockpit is still the Operator's working tool
- When the platform has met its configured stability bar — sustained unattended operation per the deployment profile's declared criteria
- Then, and only then, the work of folding the cockpit's capabilities into this surface begins; before the bar is met, the cockpit is left alone

**Scenario: Parity is proven before cutover**
- Given the cockpit's capabilities have been rebuilt inside this surface
- When cutover is considered
- Then the folded surface must first demonstrably behave the same as the cockpit on the cockpit's real workload — the same items shown, the same actions possible, the same outcomes effected — verified side by side, with discrepancies resolved before any retirement

**Scenario: The old tool is retired only after the new one carries the load**
- Given parity is proven
- When the Operator adopts the folded surface
- Then the cockpit is retired only after the folded surface has actually carried the Operator's steering for a sustained period — and if the folded surface fails him in that period, the cockpit remains available to fall back to

## Success Criteria

- The Operator steers the fleet for a full working week from this one surface — decisions, briefing, drill-downs, notes, run controls — without needing a terminal session, the separate cockpit, or any other tool for steering work
- The default view contains exactly the decisions inbox and the briefing; everything else is reached only by deliberate navigation
- The full steering loop — inbox, briefing, decision answering, drill-down, notes, run controls — is usable from a mobile device; a week of steering on the go needs no desktop
- Routine items hold to the daily batch rhythm while items meeting the interruption threshold reach the Operator between batches, on demand — nothing urgent waits for the next briefing, nothing routine interrupts
- The Operator can judge any change by its outcomes in one step — the change itself plus the checks and review verdicts that cleared it — and QA visibility outranks live execution detail throughout the surface
- The drill-down's view of a run's produced work is current within moments of the work changing, and always reflects the actual work — never the run's narrative about it
- Every steering action available in the surface takes effect through the platform's existing decision and steering behavior, with identical guarantees to those specs
- The cockpit fold begins only after the configured stability bar is met, cuts over only after side-by-side parity is proven on real workload, and retires the cockpit only after the folded surface has sustainedly carried the load — at no point is the Operator left without a working steering tool

## Constraints

- **The default surface is minimal by contract**: decisions and briefing only; adding any always-visible element to the default view is a change to this specification, not a styling choice
- **Mobile use is a requirement, not an adaptation**: the steering loop must be fully usable on a mobile device; a surface that steers only from a desk does not satisfy this specification
- **Outcome visibility outranks execution detail**: the surface's information hierarchy presents QA results and spot-checkable changes before phase or session narration — the Operator's trust mechanism is verified outcomes, and the surface is built to serve it
- The drill-down's work view is **derived from the run's actual produced work** in its isolated working area; deriving displayed state from the run's conversation, transcript, or self-description is excluded by design — the surface shows what *is*, not what the run *says*
- This surface **hosts no live terminal** and embeds no interactive session into a run's working area; depth is provided by the derived views, and live collaboration happens through the platform's interactive-session capability, not by exposing raw run internals
- The surface is a **coordinator, never an executor**: it answers decisions, shows state, and carries steering actions; it never merges, deploys, alters a pipeline phase, or edits specifications or the vision
- The surface only fronts behavior owned elsewhere — inbox semantics per FUNC-AC-FLEET, decisions and steering per FUNC-AC-DECISION-ESCALATION, management surfaces per FUNC-AC-DASHBOARD; it introduces no second path to any of them, so there is never a steering action possible here that the owning capability would not permit
- The surface holds **no write authority of its own**: everything it shows is a read-only projection of the platform's durable records, and every action it carries mutates state only through the owning capability's recorded transport — there is no state a viewer can change that the records would not show was changed, by whom, and through which capability
- The stability bar that gates the cockpit fold is a **configured value in the deployment profile**, not a fixed number in the platform or this spec; the fold's sequencing rule — bar, then parity, then sustained carry, then retirement — is normative even as the bar's value is configuration
- Showing a run's produced work must respect every confidentiality rule that governs the work itself; the surface never reveals to a viewer anything the underlying records would withhold from them
