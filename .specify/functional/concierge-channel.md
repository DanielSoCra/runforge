---
id: FUNC-CONCIERGE-CHANNEL
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE-CHANNEL — Operator Conversation Channel

## Problem Statement

The assistant needs an always-available conversational surface that delivers reliable mobile push to the operator, supports parallel topics within a single bidirectional channel, and accepts both natural-language input and one-tap structured replies (for confirmations and quick triage decisions). The channel is the assistant's primary input/output.

## Actors

- **Operator** — the sole counterpart on the channel.
- **Assistant** — the agent maintaining the conversation.
- **Confirmation message** — a structured message the assistant sends when a high-blast-radius action is pending; the operator replies via approve/deny controls.

## Behavior

### Inbound

**Scenario: Operator sends a message**
- Given the operator sends a message in the channel
- When the channel delivers it
- Then the assistant receives the message authenticated as from the operator
- And the message is routed into the appropriate conversation context (new top-level vs. continuation)

**Scenario: Authentication failure**
- Given an inbound delivery fails authentication
- When the channel processes it
- Then the message is rejected and never reaches the assistant
- And the failure is recorded

**Scenario: Reset signal**
- Given the operator sends an explicit reset request
- When the channel processes it
- Then the active conversation context is closed and the operator is acknowledged

### Outbound

**Scenario: Assistant replies in the active conversation**
- Given the assistant produces a reply
- When the channel delivers it
- Then the reply appears in the same conversation context the operator started

**Scenario: Confirmation request**
- Given a high-blast-radius action is pending
- When the assistant asks for confirmation
- Then a structured message is delivered with the proposed action's summary and approve/deny controls
- And on operator selection → the result is routed back to the assistant within the same conversation context

### Resilience

**Scenario: Channel is temporarily unavailable**
- Given the channel cannot deliver outbound messages
- When the assistant produces output
- Then the output is queued
- And on channel recovery → the queue drains in the order it was produced
- And the operator does not see a partial conversation

## Constraints

- **Operator-only.** The channel only carries messages between the operator and the assistant. Inbound messages from any other party are ignored.
- **Single channel per operator.** No multi-channel federation in v1.
- **Structured confirmations preserve identity.** A confirmation reply must be unambiguously bound to the pending action it answers.
- **No autonomous publication.** The assistant never originates a message to a channel other than the operator's, except via a confirmation-gated capability.

## Success Criterion

1. The operator's messages reach the assistant within seconds; replies arrive likewise.
2. Reset signals close the active context cleanly.
3. Confirmations are always traceable from request to response.
4. A short channel outage is invisible to the operator.

## Out of Scope

- Voice messages.
- Operator-initiated channel installation flows.
- Channels other than the operator's primary conversation channel.
- Multi-user / shared channels.
