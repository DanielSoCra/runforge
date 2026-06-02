---
id: FUNC-CONCIERGE-BOARD
type: functional
domain: concierge
status: deprecated
deprecated_by: FUNC-AC-FLEET
deprecation_date: 2026-06-02
deprecation_reason: Triage/inbox surface folded into the unified platform's focus-gated decision inbox (FUNC-AC-FLEET) + behavioral-learning ranking (FUNC-AC-OPERATOR-LEARNING) per spec-reconciliation-ledger (2026-05-29).
version: 1
layer: 1
---

> **⛔ DEPRECATED (2026-06-02).** The triage-board / decision-surface behavior specified here is now canonically covered by the unified platform specs **FUNC-AC-FLEET** (the single focus-gated cross-deployment decision inbox) and **FUNC-AC-OPERATOR-LEARNING** (learned ranking of what surfaces). Retained for history; the canonical specs in `.specify/` govern. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`.

# FUNC-CONCIERGE-BOARD — Triage Surface

## Problem Statement

The conversation channel is good for back-and-forth. It is bad for "what needs me right now?" and "what is the assistant currently doing?". The operator needs an at-a-glance surface, available on the move, that shows two things: items that need an operator decision, and items currently in flight. The surface offers one-tap actions for common decisions; it does not replicate the conversational channel.

## Actors

- **Operator** — views the surface; performs one-tap actions.
- **Assistant** — places items on the surface and reacts to operator actions.
- **Item** — a single decision-needing or in-flight unit on the surface, with optional pre-declared actions.

## Boundary vs. existing operator deep-control surface

A separate deep-control surface remains responsible for configuration, history, and administrative views. The triage surface defined here is the at-a-glance, cross-domain surface for items that need attention or are in flight. The two surfaces have distinct scopes; they may cross-link, but share no governing data and have no overlapping responsibilities.

## Behavior

### Item lifecycle

**Scenario: Assistant surfaces a decision-needing item**
- Given the assistant has classified an event as needing operator attention
- When the item is created
- Then a card appears in the "needs you" section of the surface
- And a notification is sent through the conversation channel announcing the item

**Scenario: Operator approves a pre-declared action**
- Given a card with a pre-declared "approve" action is shown
- When the operator selects approve
- Then the configured underlying action is invoked
- And on success → the card status moves to "done"
- And on failure → the card shows the error and remains visible

**Scenario: Operator snoozes a card**
- Given a card supports snooze
- When the operator snoozes for a chosen duration
- Then the card is hidden from the active view
- And it reappears automatically when the snooze expires

**Scenario: Operator dismisses a card**
- Given a card the operator wants to clear without firing its action
- When the operator dismisses it
- Then the card status moves to "dismissed"
- And the underlying event is recorded as acknowledged so it does not re-surface

### In-flight items

**Scenario: Assistant starts a long-running capability**
- Given the assistant invokes a capability whose result will not arrive within the conversation turn
- When the capability is dispatched
- Then a card appears in the "in flight" section showing the work in progress
- And the card updates as progress information is received
- And on completion → the card either auto-clears (no operator action needed) or moves to "needs you" (if review is required)

### Live updates

**Scenario: Multiple devices are open**
- Given the operator has the surface open on multiple devices
- When any item changes
- Then all open views reflect the change without manual refresh

### Empty states

**Scenario: No items need the operator**
- Given the "needs you" section is empty
- When the operator opens the surface
- Then the surface shows an explicit "all clear" state with the count of in-flight items

## Constraints

- **Pre-declared actions only.** A card's actions are static at creation time; the operator does not type free-form instructions on a card.
- **No new conversation surface.** The triage surface does not duplicate or replace the conversation channel; conversational back-and-forth happens elsewhere.
- **Restricted access.** Only the operator may view the surface; no team or shared mode.
- **No overlap with the existing operator deep-control surface.** The triage surface only shows items needing attention or in flight; deep-control views live elsewhere.

## Success Criterion

1. The operator can scan all decision-needing items in a single screen.
2. A one-tap action either fires its pre-declared underlying action or asks for approval — never asks "what next?".
3. Snoozed items reappear without further input at the chosen time.
4. The surface is viable on a phone-sized viewport.

## Out of Scope

- Composing items by the operator (cards are assistant-generated).
- Editing card text or actions after creation.
- Saved filters or per-section custom views.
- Notification mechanisms beyond the conversation channel.
- Multi-user views.
