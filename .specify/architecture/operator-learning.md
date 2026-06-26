---
id: ARCH-AC-OPERATOR-LEARNING
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-OPERATOR-LEARNING
---

# ARCH-AC-OPERATOR-LEARNING — Operator Behavioral Learning Architecture

## Overview

The Operator Learning Service observes the Operator's decision behavior, forms per-decision-class preferences scoped by context, and uses those preferences to re-rank what reaches the Operator and to propose graduated reductions in how often non-guarded classes are surfaced. It never pre-decides a guarded class, never acts autonomously on a learned preference, and never authors or edits specification content. Every adjustment is explainable, reversible per class, and auditable.

## Data Model

A **DecisionClass** identifies a category of escalation the platform can raise. It contains: a stable class key; a human-readable label; a guardrail flag indicating whether the class is safety-critical, sensitive-data, compliance, specification-content, or production-release related; and the set of contexts in which it may appear.

A **DecisionObservation** records one Operator answer to one escalated decision. It contains: the decision identifier; the decision class; the choice selected; whether that choice matched the platform's recommendation; the deployment or project context; a timestamp; and a sensitivity flag indicating whether the observation carries content that must be excluded from shared explanations.

A **ReRankObservation** records one Operator action on the inbox surface: pin, mute, defer, or reorder. It contains: the item decision class; the action kind; the prior position and resulting position; the context; and a timestamp.

A **SpecEditObservation** records that the Operator edited a suggested specification before approving it. It contains: the decision class of the original suggestion; a structural fingerprint of the edit (for example, which sections were changed and in what direction); the context; and a timestamp. It never stores the edited content itself.

A **Preference** is the learned aggregate for one decision class in one context. It contains: the decision class; the context key; a confidence score derived from repeated, varied observations; the most frequent choice; the rung currently in effect; the evidence summary (counts of matching, contradicting, and total observations); and a created/updated timestamp.

A **Rung** is a graduated autonomy level: *surface* (re-rank only, still ask), *pre-fill* (show the predicted choice as a recommendation the Operator must still confirm), or *propose-ask-less* (the platform may propose a threshold change, but the Operator must approve it). Guarded decision classes are permanently pinned to *surface*.

A **RankingAdjustment** records one concrete application of a preference: the decision class, the context, the rung in effect, the evidence summary at the time, and the timestamp. It is used for explanation and audit.

An **AskLessProposal** records a request to move a non-guarded decision class to a lower surface frequency. It contains: the decision class; the context; the proposed frequency threshold; the evidence supporting the move; a status (pending, approved, rejected); and the operator approval timestamp when applicable.

## API Contract

**Observe decision answer** — Called by the Decision Escalation system after an answer is durably recorded. Request: the decision identifier, decision class, chosen option, recommended option, context, and sensitivity flag. Response: acknowledgment. The service records a DecisionObservation and re-evaluates the preference for that class and context.

**Observe re-rank action** — Called by the Steering Surface when the Operator pins, mutes, defers, or re-orders an item. Request: the item decision class, action kind, context, and timestamp. Response: acknowledgment. The service records a ReRankObservation and updates attention-weight signals for that class and context.

**Observe spec edit** — Called by the Spec Pipeline when an Operator edits a suggested specification before approval. Request: the decision class, a structural fingerprint of the edit, the context, and the timestamp. Response: acknowledgment. The service records a SpecEditObservation; it does not store the edited content.

**Get ranked inbox** — Called by the Steering Surface when rendering the global inbox. Request: an array of pending decision items, each carrying its decision class and context; optional Operator identity. Response: the same items in ranked order, each annotated with an explanation: base priority, learned adjustment, and rung. Novel and guarded items are never suppressed; they may be re-ordered but always remain visible.

**Get pull-time relevance** — Called by the Steering Surface or Control Plane when the Operator pulls the next relevant item in a context. Request: a set of candidate items, the current context, and optional identity. Response: one selected item with the reason it was chosen, or none if no candidate matches. The choice weights learned attention by context.

**Get preference explanation** — Called by the Operator or any surface on demand. Request: decision class and context. Response: the current preference, confidence, rung, and a human-readable evidence summary.

**Reset preference** — Called by the Operator. Request: decision class and context. Effect: the preference is cleared and its rung returns to *surface*; future observations for that class and context start from a clean state. The reset is recorded in the audit log.

**Revert preference** — Called by the Operator or the Fleet demote-on-red rollback path. Request: decision class and context, or fleet-wide scope. Effect: wherever the preference was in effect, the rung falls back to the prior more cautious state and the ranking adjustment is withdrawn. The revert is recorded in the audit log.

**Propose ask less** — Called internally when a non-guarded preference reaches the confidence threshold for the *propose-ask-less* rung. Effect: creates an AskLessProposal with status *pending* and surfaces it to the Operator for approval. The proposal itself is treated as a decision request; the platform does not change surface frequency without an explicit answer.

**Approve ask less** — Called by the Operator. Request: proposal identifier. Effect: the proposal status becomes *approved*, the decision class's rung is advanced to *propose-ask-less*, and the surface frequency threshold is updated.

**Reject ask less** — Called by the Operator. Request: proposal identifier. Effect: the proposal status becomes *rejected* and the class remains at its current rung. A cooldown period prevents immediate re-proposal.

**List audit trail** — Called by the Operator or compliance tooling. Request: optional filter by decision class, context, or rung. Response: a time-ordered list of RankingAdjustments, AskLessProposals, resets, and reverts.

## System Boundaries

The **Operator Learning Service** OWNS: DecisionObservations, ReRankObservations, SpecEditObservations, Preferences, RankingAdjustments, AskLessProposals, and the audit trail.

The **Operator Learning Service** IS CALLED BY: Decision Escalation (answer observations), Steering Surface (re-rank observations and ranking queries), Spec Pipeline (spec-edit observations), and the Control Plane (reset/revert/list operations).

The **Operator Learning Service** CALLS: the Decision Escalation system to raise AskLessProposals as decision requests, and the Fleet subsystem to apply fleet-wide reverts when a learned bias must be demoted across deployments.

The **Steering Surface** reads ranked items but does not mutate preferences. It surfaces explanations and forwards Operator reset/revert requests to the Operator Learning Service.

The **Decision Escalation system** owns the lifecycle of individual decisions but forwards answer outcomes to the Operator Learning Service for behavioral aggregation.

The **Spec Pipeline** owns specification content; it forwards only structural fingerprints of edits, never the edited content itself.

The Operator Learning Service NEVER: authors or edits specification content; merges, deploys, or alters a pipeline phase; pre-decides a guarded decision class; advances a rung without recording auditable evidence; or applies a frequency change without an explicit Operator approval for the *propose-ask-less* rung.

## Event Flows

**Decision answer observation flow:**
1. The Operator submits an answer through the Steering Surface.
2. The Decision Escalation system durably records the answer.
3. Decision Escalation calls the Operator Learning Service with the answer outcome.
4. The service appends a DecisionObservation.
5. The service re-evaluates the preference for the decision class and context: it increments the matching count if the choice aligns with the existing most-frequent choice, increments the contradicting count otherwise, and recomputes confidence from the updated evidence.
6. If confidence crosses a rung threshold and the class is not guarded, the service may advance the rung or create an AskLessProposal, recording a RankingAdjustment or proposal record.

**Re-rank observation flow:**
1. The Operator pins, mutes, defers, or re-orders an item in the Steering Surface.
2. The Steering Surface calls the Operator Learning Service with the action.
3. The service appends a ReRankObservation.
4. The service updates attention weights for the affected decision class and context: pins and re-orders toward the top increase positive attention; mutes and defers decrease it.
5. The updated weights feed the next global-inbox ranking and pull-time relevance computation.

**Spec edit observation flow:**
1. The Operator edits a suggested specification before approving it.
2. The Spec Pipeline records the edit and calls the Operator Learning Service with a structural fingerprint.
3. The service appends a SpecEditObservation.
4. The service may update a framing preference for the decision class and context if the same structural change recurs, but it never stores or reproduces the edited content.

**Global inbox ranking flow:**
1. The Steering Surface requests a ranked list of pending items.
2. The Operator Learning Service receives the items and their base priorities.
3. For each item, the service looks up the preference for its decision class and context.
4. The service computes a learned score from attention weights and rung state, combining it with the base priority through a transparent, explainable function.
5. Items are sorted; guarded and novel items are never dropped.
6. Each item is annotated with its ranking explanation.

**Pull-time relevance flow:**
1. The Operator pulls the next relevant item in a specific context.
2. The service receives candidate items and the context.
3. It scores candidates by context-specific learned attention and global preference.
4. It returns the highest-scoring candidate with the reason for the choice.

**Ask-less proposal flow:**
1. A non-guarded preference reaches the confidence threshold for the *propose-ask-less* rung.
2. The Operator Learning Service creates an AskLessProposal.
3. The Decision Escalation system raises the proposal as a decision request to the Operator.
4. The Operator approves or rejects the proposal.
5. On approval, the rung advances and the surface frequency threshold is updated; on rejection, the class remains at its current rung and enters a cooldown.

**Reset flow:**
1. The Operator requests a reset for a decision class and context.
2. The service clears the preference and rung state for that class and context.
3. The service appends a reset record to the audit trail.
4. Future observations for that class and context start from a clean state.

**Revert flow:**
1. The Operator or Fleet subsystem requests a revert for a decision class and context (or fleet-wide).
2. The service withdraws the active ranking adjustment and returns the rung to the prior more cautious state.
3. The service appends a revert record to the audit trail.
4. For fleet-wide reverts, the service coordinates with the Fleet subsystem to apply the revert across deployments.

## Error Handling

**Observation with unknown decision class.** The observation is stored under the literal class key. The preference remains low-confidence until repeated observations allow a stable aggregate to form.

**Contradicting answer.** The service lowers confidence for the affected preference. It never raises confidence on a single occurrence and never advances a rung after a contradiction until the evidence stabilizes again.

**Sensitive observation.** If the sensitivity flag is set, the observation is excluded from shared explanations and audit entries; only the existence of the observation contributes to the aggregate count.

**Missing context.** When context is absent, the service uses a default context key. Context-scoped preferences prevent cross-deployment leakage.

**Guarded class rung escalation attempt.** Any attempt to advance a guarded class beyond *surface* is rejected and logged. The class remains at *surface*.

**Ask-less proposal without Operator approval.** The platform never changes surface frequency without an approved AskLessProposal. If the proposal system is unavailable, the class stays at its current rung.

**Reset/revert race.** Reset and revert operations are atomic per decision-class and context. Concurrent reset and observation updates are serialized so the audit trail remains consistent and the reset is honored.

**Audit store corruption.** The audit trail is append-only. On read failure, the service recovers by reading all valid entries up to the corruption point and logs a warning. The preference state itself is reconstructible from observations, so a lost audit entry does not lose the learned state.

**Fleet-wide revert failure.** If a fleet-wide revert cannot reach one deployment, the service records the pending revert and retries. The Operator is notified of deployments that have not yet acknowledged the revert.
