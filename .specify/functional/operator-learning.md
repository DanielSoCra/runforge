---
id: FUNC-AC-OPERATOR-LEARNING
type: functional
domain: auto-claude
status: approved
version: 2
layer: 1
---

# FUNC-AC-OPERATOR-LEARNING — Operator Behavioral Learning

## Problem Statement

The Operator is the scarce resource. Every decision the platform escalates costs a slice of his attention, and a great many of those decisions are predictable: he approves the same low-risk decision-classes every time, he always dismisses a particular kind of finding, he re-ranks the inbox the same way each morning, and he edits a suggested specification toward the same shape before approving it. Today the platform asks about all of these with equal weight and surfaces them in a fixed order, so the Operator keeps paying attention to choices he has effectively already made — and the genuinely novel decision sits in the same undifferentiated backlog as a dozen routine ones.

The platform already promises to *ask less over time*. It learns one way through the skills and instructions the Operator improves; it must also learn from the Operator's own behavior — which decision-classes he consistently approves or takes the recommendation on, what he consistently dismisses, how he orders his attention, and how he reshapes what is proposed to him. What the platform can confidently predict, it should stop asking about, and what the Operator clearly cares about most, it should surface first. But this learning sits directly against the platform's hardest boundary: it must make the Operator's attention go further **without ever deciding on his behalf the things only he may decide**, and without ever becoming an opaque bias he cannot see, question, or undo.

This capability is the behavioral-learning loop: it observes the Operator's decision behavior, and over time it (1) re-ranks what surfaces to him — both in the global inbox and at the moment he pulls work in a given context — and (2) raises an explainable, reversible confidence that lets it ask *less* about decision-classes it has learned, strictly within hard guardrails it may never cross.

## Actors

- **Operator** — makes the decisions, re-ranks the inbox, pins, mutes and defers items, edits suggested specifications, and remains the sole authority over the guarded decision-classes; can inspect and reset anything the platform has learned about him.
- **Learning Function** — the platform role that observes the Operator's decision behavior, forms an explainable per-decision-class understanding of his preferences, proposes graduated changes to how much is asked and in what order things surface, and never itself crosses a guardrail.

## Behavior

### Observing behavior

**Scenario: A decision outcome is observed**
- Given the Operator answers a decision the platform escalated
- When the answer is recorded
- Then the Learning Function notes the decision-class, the option chosen, whether it matched the platform's recommendation, and the context it arrived in
- And this observation becomes evidence about that decision-class, attributable to a real Operator action rather than inferred from nothing

**Scenario: Re-ranking behavior is observed**
- Given the Operator pins, mutes, defers, or re-orders items in the inbox
- When the platform records the change
- Then the Learning Function treats it as a signal about what the Operator wants surfaced first and what he wants out of his way

**Scenario: Specification-editing behavior is observed**
- Given the platform suggested a specification and the Operator edited it before approving
- When the edit is recorded
- Then the Learning Function may note the recurring shape of the change as a preference about how suggestions should be framed
- And it never treats this as permission to author or alter specification content itself

### Forming a preference, per decision-class

**Scenario: A consistent preference raises confidence in a decision-class**
- Given the Operator has answered a non-guarded decision-class the same way across repeated, varied occurrences
- When the Learning Function evaluates that decision-class
- Then it raises its confidence that the Operator's choice is predictable for that class
- And it can state, in plain terms, the evidence the confidence rests on

**Scenario: A contradicting decision lowers confidence**
- Given the platform held a confidence about a decision-class
- When the Operator makes a choice that contradicts the learned pattern
- Then the Learning Function lowers its confidence for that class
- And it never raises confidence on a single occurrence — confidence requires a consistent, repeated pattern

**Scenario: Confidence is scoped, not global**
- Given the Operator behaves one way in one deployment or context and differently in another
- When the Learning Function forms preferences
- Then confidence is held per decision-class and per context, never as one hidden cross-deployment ranking applied everywhere

### Acting on a preference — graduated rungs only

**Scenario: First rung — surface differently, still ask**
- Given the Learning Function has formed a preference about a non-guarded decision-class
- When items of that class reach the inbox
- Then the lowest-impact action is taken first: the items are re-ranked and pull-time relevance is adjusted, but the Operator is still asked every time
- And nothing about the decision itself is pre-decided

**Scenario: Second rung — pre-fill a recommendation, still ask**
- Given confidence in a non-guarded decision-class has grown beyond the surfacing rung
- When such an item is presented
- Then the platform pre-fills its predicted choice as the recommended option with the reason shown, so the Operator can confirm in one action
- And the Operator must still confirm — the platform does not act on the pre-filled choice on its own

**Scenario: Third rung — proposing to ask less is itself a decision the Operator makes**
- Given confidence in a non-guarded decision-class is consistently high
- When the Learning Function judges that the platform could ask less about that class
- Then it does not start asking less on its own; it raises a decision request asking the Operator to approve a change to how often that class is surfaced
- And only after the Operator approves does the threshold change take effect
- And the platform never jumps directly to deciding a class autonomously — every widening of autonomy passes through an Operator decision, one rung at a time

**Scenario: Fourth rung — acting on the Operator's behalf only within a bound he explicitly grants**
- Given a non-guarded decision-class the platform already asks less about, and the Operator's answer to it has stayed consistent
- When the Learning Function judges it could handle routine instances of that class on the Operator's behalf
- Then it does not begin acting on its own; it raises a separate decision request that plainly states it would apply the Operator's usual answer automatically to routine instances, names the kinds of instances it will never act on, and names how to switch it back off
- And only after the Operator approves that specific request does the platform begin applying the learned answer automatically, and only to routine instances of that non-guarded class
- And it never acts automatically on an instance that is safety-critical, concerns sensitive data, a compliance gate, specification content, or a production release; that carries an unresolved flag for discussion; or that is unlike the instances the preference was learned from — each of these still reaches the Operator
- And every automatic action is recorded as the platform's own action, with the reason and the approval behind it, is never counted as new evidence of the Operator's behavior, and can be switched back off — after which the class returns to being asked

**Scenario: A guarded decision-class never advances past the first rung**
- Given a decision-class concerns a safety-critical change, sensitive data, a compliance gate, specification content, or a production release
- When the Operator answers it consistently the same way
- Then the Learning Function may re-rank and surface it more usefully, but never pre-fills it as auto-confirmable, never proposes to ask less about it, and never lets it advance toward an autonomous decision
- And these classes are always asked, no matter how predictable the Operator's behavior becomes

### Re-ranking what surfaces

**Scenario: Global inbox order reflects learned attention**
- Given the inbox holds several pending decisions
- When the Operator opens it
- Then items are ordered using the learned preference on top of the explainable base priority, so what the Operator consistently treats as most important surfaces first
- And the ordering remains explainable: each item can show why it is ranked where it is

**Scenario: Pull-time contextual relevance**
- Given the Operator is working in a specific context and pulls the next most relevant item or suggestion
- When the platform selects what to offer
- Then it weights the choice by what the Operator has historically engaged with in that context, not only by global rank
- And the surfaced item carries the reason it was chosen for this moment

**Scenario: Learned ordering never suppresses a guarded or novel decision**
- Given a guarded decision-class item or a decision unlike anything the platform has seen exists
- When the inbox is ranked
- Then learned preference may change order but never hides or drops such an item; a genuinely novel or guarded decision always reaches the Operator

### Transparency, control, and reversal

**Scenario: Every learned adjustment is explainable**
- Given the platform has re-ranked, pre-filled, or changed how often a class is asked
- When the Operator asks why
- Then the platform shows the decision-class, the observed behavior it learned from, the current confidence, and which rung is in effect — no adjustment is silent or unexplained

**Scenario: The Operator resets a learned bias**
- Given the platform has formed a preference the Operator disagrees with
- When the Operator resets it
- Then the platform returns that decision-class to asking as it did before any learning, discards the learned bias, and resumes observing from a clean state
- And the reset is honored immediately, for that class, without affecting unrelated learning

**Scenario: A bad learned bias is reversible wherever it took effect**
- Given a learned preference proves wrong or harmful after it took effect
- When it is reverted
- Then the revert can be applied wherever that preference was in effect, and the platform falls back to the prior, more cautious behavior

**Scenario: Sensitive behavior is not learned into shared adjustments**
- Given an observation would carry confidential or sensitive content
- When the Learning Function records evidence or explains an adjustment
- Then that content is kept out of any shared preference, ranking explanation, or audit entry, following the same confidentiality rules as the rest of the platform

**Scenario: Every adjustment is auditable**
- Given the platform changed how it surfaces or asks about any class over time
- When the Operator reviews the history
- Then each change is recorded with its date, the rung it moved to, the evidence behind it, and — where a threshold changed — the Operator approval that authorized it

## Success Criteria

- The platform measurably asks the Operator less over time about non-guarded decision-classes it has learned, while the count of guarded decisions reaching him is unchanged.
- What the Operator consistently treats as most important surfaces first, both in the global inbox and at the moment he pulls work in context, and every placement can be explained.
- No decision-class advances toward autonomy except one rung at a time, with the move to ask less always authorized by an explicit Operator decision.
- When the Operator has explicitly authorized it for a non-guarded class, the platform handles routine instances of that class automatically — applying his learned answer, recording each action visibly, and still escalating every novel, guarded, safety-critical, sensitive, compliance, specification-content, production-release, or flagged instance — and he can switch that authorization back off at any time, after which the class returns to being asked.
- No guarded decision-class — safety-critical, sensitive-data, compliance, specification-content, or production-release — is ever pre-filled as auto-confirmable, proposed for less asking, or decided without the Operator.
- A genuinely novel or guarded decision always reaches the Operator regardless of learned ranking; learning never hides or drops an item.
- The Operator can ask why any adjustment exists and get the evidence and rung behind it; he can reset any learned bias and have it honored immediately.
- A learned preference that proves wrong can be reverted everywhere it was in effect, falling back to the prior, more cautious behavior.

## Constraints

- The platform never autonomously decides a safety-critical, sensitive-data, compliance, specification-content, or production-release question, no matter how confidently it has learned the Operator's behavior — these always reach the Operator. This guardrail overrides every learned preference.
- Widening how much the platform may act on a learned preference is graduated and never a binary jump to autonomous decision: surface differently → pre-fill a recommendation the Operator still confirms → propose a change to how often a class is asked, which only the Operator may approve → and, only for a non-guarded class and only after a further explicit Operator approval, apply the Operator's learned answer automatically to routine instances of that class, within the guards it may never cross.
- Confidence is raised only from a consistent, repeated pattern of the Operator's own decisions across varied occurrences — never from a single decision, and never from the platform's own automatic actions — and is lowered by any contradicting choice.
- Every learned adjustment — to ranking, to pre-filling, or to how often a class is asked — must be explainable to the Operator on demand and recorded so it is auditable after the fact.
- The Operator can reset any learned preference at any time; a reset returns that decision-class to its pre-learning behavior immediately and is always available.
- A learned bias that proves wrong must be reversible wherever it took effect, falling back to the prior, more cautious behavior; the platform never learns its way into a state it cannot back out of. For a bias that took effect across deployments, this revert is fleet-wide, realized by FUNC-AC-FLEET's demote-on-red rollback.
- Learned preferences are held per decision-class and per context — never as a single hidden global ranking — and remain visible rather than silently computed.
- The Learning Function only observes behavior and adjusts how things are surfaced and asked; it never authors or edits specification content, never merges, never deploys, and never alters a pipeline phase.
- Confidential or sensitive content observed in the Operator's behavior is never folded into a shared preference, a ranking explanation, or an audit entry, and follows the same confidentiality rules as the rest of the platform.
- Learning never silently suppresses, hides, or drops a decision; it changes order and emphasis only — except that, for a non-guarded class the Operator has explicitly authorized the platform to handle automatically, the platform may apply his learned answer and must record that action visibly rather than acting silently. Even then, a novel, guarded, safety-critical, sensitive, compliance, specification-content, production-release, or flagged instance always still reaches the Operator.
