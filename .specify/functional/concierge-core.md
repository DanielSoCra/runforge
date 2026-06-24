---
id: FUNC-CONCIERGE-CORE
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE-CORE — Conversational Concierge

> **DISPOSITION — FOLD-IN (ratified 2026-06-24, decision `concierge-vs-platform`).** This spec is being folded into the one operations-OS platform. Its parent vision is re-parented from the separate, now-**deprecated** concierge L0 (`L0-CONCIERGE-VISION`, `.specify/L0-vision.md`) to the platform L0 **L0-AC-VISION**; there is one operations-OS, not a separate single-tenant product. **Live-behavior mapping:** the conversational assistant's intent→action loop maps onto the platform's operator surface (**FUNC-AC-OPERATOR-SURFACE**) plus the **decision inbox** (**FUNC-AC-DECISION-ESCALATION**) — the operator steers and confirms there, not in a parallel concierge cockpit. **This is a disposition marker, not a reconciliation:** no content is deleted, no behavior is yet re-homed or verifier-gated, and the two-vision conflict is surfaced (not hidden) pending the tracked follow-on (per-behavior mechanism-vs-policy classification → re-parent/approve only proven platform-native, verifier-gatable pieces). Status stays `draft`.

## Problem Statement

The operator manages many parallel workstreams (software engineering, freelance work, ministry, personal life). Each workstream has its own context, commitments, communications, and delivery obligations. The cost is not the individual systems; it is the routing decision the operator makes a hundred times a day. The concierge is a single conversational assistant the operator can talk to in plain language. The assistant turns intent into action across the available competences, executes routine work itself, and asks for confirmation only when an action is irreversible or visible to people other than the operator.

## Actors

- **Operator** — the single human user.
- **Assistant** — the conversational agent that owns the conversation with the operator and decides what to do.
- **Capability** — an addressable competence the assistant can invoke. Capabilities have known input shapes and a declared blast radius.
- **Confirmation Gate** — a guard the assistant must pass before invoking a high-blast-radius capability.

## Behavior

### Conversation lifecycle

**Scenario: New conversation**
- Given the operator sends a top-level message
- When the assistant receives it
- Then a new conversation context is established
- And subsequent operator messages within the same context continue that conversation

**Scenario: Operator continues an existing conversation**
- Given a conversation context exists
- When the operator continues it
- Then the assistant has access to all prior turns within that context

**Scenario: Operator requests a fresh start**
- Given the operator explicitly asks to reset
- When the assistant receives the reset signal
- Then the current conversation context is closed
- And the next operator message starts a new context

### Capability invocation

**Scenario: Low-blast-radius capability**
- Given the assistant decides to invoke a capability whose effects are reversible and visible only to the operator
- When the capability is invoked
- Then the work is performed immediately and the result is reported back in the conversation

**Scenario: High-blast-radius capability**
- Given the assistant decides to invoke a capability whose effects are irreversible or affect parties other than the operator
- When the capability is selected
- Then the assistant first asks the operator to approve the proposed action, including a summary of what will be done and why approval is needed
- And on operator approval → the capability runs and the result is reported back
- And on operator denial → the assistant is told the action did not proceed
- And if the operator does not respond within 24 hours → the assistant is told the request expired

**Scenario: Unknown capability**
- Given the assistant attempts to use a capability that is not currently available
- When the request is dispatched
- Then the assistant is told the capability is unavailable and may continue the turn with another approach

### Out-of-scope handling

**Scenario: Operator asks for something outside the assistant's competence**
- Given the operator's intent does not map to any available capability
- When the assistant evaluates the request
- Then the assistant declines the request, briefly stating what kinds of work it does cover, and does not invent a capability

### Recurring patterns

**Scenario: A multi-step procedure repeats**
- Given the operator and assistant have walked through the same multi-step procedure several times in distinct conversations
- When the assistant recognises the recurrence
- Then the assistant proposes saving the procedure as a named, reusable shortcut, and asks the operator to confirm
- And on operator approval → the shortcut becomes invocable in future conversations
- And on operator denial → no shortcut is saved and the assistant continues to walk through the procedure as before

### Coexistence with manual work

**Scenario: Operator works outside the conversation**
- Given the operator performs work in some other tool without involving the assistant
- When the assistant subsequently needs context about that work
- Then the assistant may ask the operator, but does not interrupt the operator with unsolicited commentary about it

## Constraints

- **One thread of work per conversation.** The assistant does not divide a single conversation across parallel workers; long-running work appears as a single ongoing turn from the operator's perspective.
- **Audit trail mandatory.** Every capability invocation — successful, denied, expired, or errored — is recorded.
- **No self-modification.** The assistant cannot change its own configuration, its rules, or its specifications.
- **No autonomous external communication.** Any action whose audience extends beyond the operator (a message to another person, a publication, a cross-system change) flows through the Confirmation Gate.

## Success Criterion

1. The operator's intent expressed in plain language is recognised and acted on.
2. Reversible work proceeds without confirmation; irreversible or externally-visible work always asks first.
3. Recurring procedures are recognised and offered as shortcuts.
4. The assistant maintains conversational coherence across turns within a context.

## Out of Scope

- Multiple simultaneous conversations beyond what the underlying conversation channel naturally supports.
- Voice input.
- Multi-user / shared assistant state.
- Autonomous deployment to production.
- Replacing any of the underlying systems the assistant uses.
