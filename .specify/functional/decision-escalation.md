---
id: FUNC-AC-DECISION-ESCALATION
type: functional
domain: auto-claude
status: draft
version: 3
layer: 1
---

# FUNC-AC-DECISION-ESCALATION — Structured Decision Escalation and Run Steering

> **Spec history (v2, 2026-06-11):** v2 adds the reverse direction over the same uniform transport: Operator-initiated guidance to a specific running team (notes applied at phase boundaries) and the three run controls (pause, redirect, abort), per masterplan decision D4. v1 (approved, the run→Operator direction) is carried forward unchanged. Altering a run's work mid-thought is an explicit exclusion, recorded in Constraints.
>
> **Spec history (v2.1, 2026-06-11, alignment interview):** Adds the **technology-selection / baseline-decision class** to the always-escalate set, with a shape requirement: a request of this class must arrive as a researched decision brief — a highly informed set of options with trade-offs and a recommendation the Operator can decide from directly. Day-to-day implementation choices (naming, schemas, code structure) are explicitly excluded from escalation; they are the platform's to make and record.
>
> **Spec history (v2.2, 2026-06-14, L0 v6 enactment):** Re-approval pass, no content change. The Operator re-approves the v2/v2.1 content alongside the L0 v6 delta enactment; the always-escalate set defined here (including the technology-selection class) is the set L0 v6's pre-approved earn-in auto-promotion is explicitly barred from crossing. This sets `status: approved`.
>
> **Spec history (v3, 2026-06-18, confidentiality becomes a configurable capability):** Content confidentiality changes from an always-on guarantee to a **capability that is off by default**. The platform recognizes and withholds confidential or secret content only where a deployment has been set up for it; with none set up, decision content is recorded and shown as provided. Rationale: the prior always-on rule was domain baggage carried in from another product and did nothing for the default deployment; recognizing sensitive content belongs to how a deployment is set up, not a rule every request must satisfy. The always-escalate set (the technology-selection class) is unchanged. `status: draft` pending Operator re-approval.

## Problem Statement

When an autonomous run reaches a point it cannot pass without a human choice, today it leaves a free-form note and a generic human-required marker. That is workable for one team watched by one person, but the Operator now oversees several autonomous teams at once and must field the pauses from all of them. A free-form note cannot be reliably understood, prioritized, or routed when it arrives alongside dozens of others from different teams: the Operator has to open each run to learn what is actually being asked. Worse, a pause that can only be cleared by restarting the run throws away the partial work already done, and a note read in two places can be answered twice with conflicting effect. The Operator needs every pause that requires a decision to arrive as a uniform, self-contained item — the precise question, just enough context to decide, the available choices with a recommendation, what happens if it goes unanswered, and how reversible the decision is — so that a single answer transparently continues the exact work that was waiting on it.

The same need exists in the other direction. Today the Operator can only influence a run when *it* chooses to pause and ask; when he sees a run heading somewhere wrong — the wrong interpretation, a better approach, new information — his only tools are to let it finish wrong or to kill it and lose the work. What is missing is a way to steer mid-flight without grabbing the wheel: a note addressed to one specific run, delivered when that run next reaches a natural boundary between phases of its work, taken into account from then on — plus three blunt controls (hold the run, change its direction, stop it for good) with the same reliability guarantees as decisions themselves. Guidance that arrived twice, landed on the wrong run, or silently vanished would be worse than none; and guidance injected into the middle of a run's in-flight thought would corrupt the very work it meant to improve, so it is deliberately excluded.

## Actors

- **Operator** — the human who reads decision requests and answers them, and who sends notes and run controls (pause, redirect, abort) to specific running teams
- **Worker** — an autonomous run; raises a decision request when it cannot proceed and continues once answered; receives Operator notes at its phase boundaries and honors run controls
- **Control Plane** — assembles each request into its uniform form, records the Operator's answer, and continues or restarts the waiting run; delivers notes and run controls to the exact run they address, exactly once, at the next phase boundary

## Behavior

**Scenario: Decision request raised**
- Given a run reaches a point it cannot pass without a human choice
- When it pauses
- Then a decision request is created stating the question, a concise slice of context, the available choices with a recommended choice, the consequence of leaving it unanswered, how reversible the decision is, and a deadline

**Scenario: Answer continues the waiting run**
- Given a run is paused on a decision request
- When the Operator selects one of the offered choices
- Then the same run continues from where it paused, using that choice, with no further Operator action

**Scenario: Restart when continuation is impossible**
- Given a paused run can no longer be continued where it left off
- When the Operator's answer is recorded
- Then the work is started again with the answer carried into it, and the Operator is told the earlier partial work may be repeated

**Scenario: An answer takes effect once**
- Given a decision request has already been answered
- When a further answer arrives for the same request
- Then the run proceeds on the first valid answer and the later answer changes nothing

**Scenario: Answer must match the offered choices**
- Given a decision request offers a defined set of choices
- When an answer is submitted
- Then only an answer that matches the offered choices is accepted

**Scenario: A technology-selection decision always reaches the Operator as a researched brief**
- Given work surfaces a baseline technology decision — which database, which cloud or hosting provider, which reasoning-model vendor or family, or any comparable choice that sets a foundation later work builds on
- When the platform encounters it
- Then the question is never decided autonomously, at any earned-autonomy level, in any lane, in any lifecycle phase: it is raised as a decision request of the technology-selection class, carrying a researched set of viable options with their trade-offs and a recommended choice — a brief the Operator can decide from directly, never a bare question that sends him off to do the research himself

**Scenario: Day-to-day implementation choices are never escalated as decisions**
- Given a run faces an ordinary implementation choice — naming, the shape of a schema, code structure, which existing pattern to follow — within its declared scope and the platform's rules
- When the run proceeds
- Then it makes such choices itself and records them in its work; routine development choices never become decision requests, and the technology-selection class is never widened to cover them — the class exists for foundations, not for the day-to-day

**Scenario: Sensitive content is withheld when the platform is set up to recognize it**
- Given the platform has been set up, for a given deployment, to recognize confidential or secret information in incoming decision content
- When a decision request would carry such content
- Then that content is kept out of the shared item and its notifications, and is revealed only to the authorized Operator when viewing the request

**Scenario: Content is recorded as provided when no recognition is set up**
- Given the platform has not been set up to recognize confidential or secret content for a deployment
- When a decision request is recorded
- Then its content is recorded and shown as provided, with nothing withheld

**Scenario: Unanswered request is re-surfaced**
- Given a decision request has passed its deadline with no answer
- When the deadline lapses
- Then the request is marked overdue and brought back to the Operator's attention rather than dropped, and the stated consequence of no answer takes hold

**Scenario: Moot request is withdrawn**
- Given a decision request is open
- When the work it belongs to is cancelled or the question no longer applies
- Then the request is withdrawn so the Operator is not asked to decide something that no longer matters

**Scenario: Older pauses are made uniform**
- Given a pause that left only a free-form note in the older style
- When it is detected
- Then it is turned once into a uniform decision request so it can be read and answered the same way as the rest

**Scenario: Operator sends a note to a running team**
- Given a run is in progress and the Operator has guidance for it — a correction, new information, a preferred approach
- When the Operator addresses a note to that specific run
- Then the note is delivered to that run when it next reaches a boundary between phases of its work, and the run takes the note into account in everything it does from that boundary on

**Scenario: A note takes effect exactly once, on the run it addresses**
- Given a note has been addressed to a specific run
- When it is delivered
- Then it is applied exactly once and only to that run — a note re-sent, read in two places, or duplicated in transit changes nothing further, and a note can never land on a different run than the one it was addressed to

**Scenario: A note is accepted only against the run state it was written against**
- Given the Operator wrote a note while looking at a run in a particular state
- When the run has meanwhile moved past the situation the note addressed
- Then the Operator is told the run has moved on rather than the note being silently applied to a situation it was not written for, and he may re-issue it against the current state

**Scenario: A note for a finished run is returned, not dropped**
- Given a note is addressed to a run that has completed, been stopped, or no longer exists
- When delivery is attempted
- Then the Operator is told the note could not be delivered and why — it is never silently discarded and never applied to a successor run

**Scenario: Operator pauses a run**
- Given a run is in progress
- When the Operator pauses it
- Then the run finishes the phase it is in, then holds at the boundary — doing no further work and spending no further budget — until the Operator resumes or aborts it, and its held state is visible

**Scenario: Operator redirects a run**
- Given a run is in progress and the Operator wants it to change direction
- When the Operator redirects it with the new direction stated
- Then from its next phase boundary the run continues under the new direction, the redirection is recorded, and work already completed is preserved rather than thrown away wherever it remains consistent with the new direction

**Scenario: Operator aborts a run**
- Given a run is in progress
- When the Operator aborts it
- Then the run stops at the earliest safe point, no further work or spend occurs on it, whatever partial work exists is preserved and labeled as abandoned rather than deleted, and the abort with its reason is recorded

**Scenario: Steering never interrupts mid-thought**
- Given a run is in the middle of a phase when a note or control arrives
- When the platform applies it
- Then notes and redirections take effect only at the next phase boundary — the platform never splices guidance into the middle of the run's in-flight work; only abort may cut a phase short, and even abort stops at the earliest safe point rather than mid-write

## Success Criteria

- Every run pause that needs a human decision produces a self-contained item the Operator can act on without opening the run
- The Operator answers with a single choice, and the run continues or restarts without further intervention
- An answer takes effect exactly once, even when submitted more than once or from more than one place
- Baseline technology decisions reach the Operator as decision-brief-shaped requests — researched options, trade-offs, a recommendation — and are never made autonomously; ordinary day-to-day implementation choices never reach the inbox as decisions
- Where the platform has been set up to recognize confidential or secret content, that content never appears in shared items, notifications, or run history and is shown only to the authorized Operator; where it has not, content is recorded and shown as provided
- No decision request is silently lost; each one ends answered, withdrawn, or overdue-and-re-surfaced
- A coordinator overseeing several teams can read, prioritize, and route any team's request and its answer without knowing that team's internals
- The Operator can steer a heading-wrong run without killing it: a note reaches exactly the run it addresses, exactly once, at its next phase boundary, and demonstrably changes what the run does from there
- No note or control is ever silently lost, duplicated in effect, or applied to the wrong run or to a state it was not written against; undeliverable guidance is always returned to the Operator with its reason
- Pause, redirect, and abort each behave as stated — held runs spend nothing, redirected runs preserve consistent prior work, aborted runs stop at the earliest safe point with partial work preserved — and each use is recorded

## Constraints

- A run must not continue or repeat any work before the Operator's answer has been durably recorded
- The Operator must always be told whether answering continues the exact run or restarts it, so a possible repeat of partial work is never a surprise
- Decisions that are hard to reverse or that cause effects outside the system must be marked as such in the request
- Recognizing and withholding confidential or secret content is a capability the platform applies only where a deployment has been set up for it, and is not applied by default; where it is applied, such content must follow the same confidentiality rules as the rest of the system and never be exposed to anyone but the authorized Operator
- A decision request must be understandable and routable on its own, independent of the team that raised it
- The **technology-selection / baseline-decision class belongs to the always-escalate set**: no earned autonomy, lane policy, lifecycle phase, or learned behavior reduces its escalation; a request of this class must carry a researched option set with trade-offs and a recommendation before it is surfaced; and the class covers foundational choices (databases, hosting and cloud providers, reasoning-model vendors, comparable load-bearing technology) — never day-to-day implementation choices, which are explicitly excluded from escalation
- Existing human-required signals must remain understandable while the uniform requests are introduced
- Notes and run controls travel over the **same uniform, durably-recorded transport** as decisions, with the same guarantees: durably recorded before taking effect, effective exactly once, scoped to the single run they address, and verified against the run state they were written against — stale guidance is returned, never silently applied
- **Mid-thought injection is excluded by design**: the platform never alters, appends to, or splices guidance into a run's in-flight reasoning; phase boundaries are the only points where notes and redirections take effect, and this exclusion is not configurable
- Steering controls govern pace and direction only; a note or redirect never bypasses a gate, never approves a decision, never merges, and never widens what the run was permitted to touch
