---
id: FUNC-AC-DECISION-ESCALATION
type: functional
domain: auto-claude
status: approved
version: 1
layer: 1
---

# FUNC-AC-DECISION-ESCALATION — Structured Decision Escalation

## Problem Statement

When an autonomous run reaches a point it cannot pass without a human choice, today it leaves a free-form note and a generic human-required marker. That is workable for one team watched by one person, but the Operator now oversees several autonomous teams at once and must field the pauses from all of them. A free-form note cannot be reliably understood, prioritized, or routed when it arrives alongside dozens of others from different teams: the Operator has to open each run to learn what is actually being asked. Worse, a pause that can only be cleared by restarting the run throws away the partial work already done, and a note read in two places can be answered twice with conflicting effect. The Operator needs every pause that requires a decision to arrive as a uniform, self-contained item — the precise question, just enough context to decide, the available choices with a recommendation, what happens if it goes unanswered, and how reversible the decision is — so that a single answer transparently continues the exact work that was waiting on it.

## Actors

- **Operator** — the human who reads decision requests and answers them
- **Worker** — a paused autonomous run; raises a decision request when it cannot proceed, and continues once answered
- **Control Plane** — assembles each request into its uniform form, records the Operator's answer, and continues or restarts the waiting run

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

**Scenario: Sensitive content is withheld**
- Given a decision request would carry confidential or secret information
- When the request is recorded or shown anywhere
- Then that content is kept out of the shared item and its notifications, and is revealed only to the authorized Operator when viewing the request

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

## Success Criteria

- Every run pause that needs a human decision produces a self-contained item the Operator can act on without opening the run
- The Operator answers with a single choice, and the run continues or restarts without further intervention
- An answer takes effect exactly once, even when submitted more than once or from more than one place
- Confidential and secret content never appears in shared items, notifications, or run history
- No decision request is silently lost; each one ends answered, withdrawn, or overdue-and-re-surfaced
- A coordinator overseeing several teams can read, prioritize, and route any team's request and its answer without knowing that team's internals

## Constraints

- A run must not continue or repeat any work before the Operator's answer has been durably recorded
- The Operator must always be told whether answering continues the exact run or restarts it, so a possible repeat of partial work is never a surprise
- Decisions that are hard to reverse or that cause effects outside the system must be marked as such in the request
- Confidential and secret information carried in a request must follow the same confidentiality rules as the rest of the system and never be exposed to anyone but the authorized Operator
- A decision request must be understandable and routable on its own, independent of the team that raised it
- Existing human-required signals must remain understandable while the uniform requests are introduced
