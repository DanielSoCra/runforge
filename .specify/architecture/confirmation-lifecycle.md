---
id: ARCH-CONFIRMATION-LIFECYCLE
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE-CORE
---

# ARCH-CONFIRMATION-LIFECYCLE — Confirmation Lifecycle

## Overview

A first-class cross-cutting concept. Any tool call with `blastRadius: 'high'` (or any tool with `requires_confirmation: true` for non-blast-radius reasons) follows this lifecycle. Confirmation is NOT a tool-router-internal flag — it's a multi-step state machine with its own table, a Slack message, optional board surface, expiry, and audit log.

## State machine

```
                ┌─────────────────────────────────────────────────┐
                │                                                  │
LLM tool_use ──► tool_router intercepts ──► PENDING ──► confirm Slack message posted
                                              │
                          ┌───────────────────┼─────────────────────────┐
                          │                   │                         │
                       APPROVED            DENIED                    EXPIRED (24h)
                          │                   │                         │
                          ▼                   ▼                         ▼
                       handler              tool_use returns          tool_use returns
                       executes             {error: denied}           {error: expired}
                          │
                       SUCCESS or ERRORED
```

## Schema

```sql
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,                   -- ulid
  tool_call_id TEXT NOT NULL,            -- references tool_calls.id (the pending row)
  conversation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,                    -- JSON
  blast_reason TEXT NOT NULL,            -- "external email", "merge to main", etc.
  status TEXT NOT NULL,                  -- pending|approved|denied|expired|errored
  slack_message_ts TEXT,                 -- the Block Kit message posted; null if not yet sent
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  expires_at INTEGER NOT NULL            -- created_at + 24h
);

CREATE INDEX idx_confirmations_pending ON confirmations (status, expires_at) WHERE status = 'pending';
```

## Slack message shape

A Block Kit message in the operator's DM thread with:
- A header: "Confirm: <tool_name>"
- A section listing the args (formatted for human readability)
- A "Why this needs confirmation" line (`blast_reason`)
- Two buttons: ✅ Approve (`action_id: confirm:<conf_id>:approve`) and ❌ Deny (`action_id: confirm:<conf_id>:deny`)
- A footer with the expiry time

When the operator taps:
- Slack posts a `block_actions` event to the slack-adapter
- The adapter parses the action_id, looks up the confirmation, and sets status accordingly
- The original message is updated: header changes to "Approved by you" / "Denied by you" with timestamp; buttons removed
- The pending tool call is resumed (handler runs on approve; error returned on deny)

## Expiry

A periodic job in `concierge-core` (every 60 s) scans `confirmations WHERE status = 'pending' AND expires_at < now()`. For each, status flips to `expired`, the Slack message is updated to "Expired (no response)", the pending tool call is resumed with `{error: "confirmation timed out"}`, and the LLM sees the error.

## Audit

Every confirmation lifecycle transition writes to `tool_calls`:
- creation: `tool_calls` row with `status: pending_confirmation`
- approval: row updated to `status: confirmed; responded_at = now`
- denial: row updated to `status: denied; responded_at = now`
- expiry: row updated to `status: expired; responded_at = now`

The audit row carries the slack_message_ts for traceability.

## Board interaction

If the same logical action also surfaces a board card (e.g. an "approve auto-claude L1 spec" card), the card and the confirmation share the same `confirmation_id`. Tapping the card's Approve button and the Slack confirm button are equivalent — both resolve the same confirmation. Only one client wins; the other is shown "already approved by you (other surface)".

## Constraints

- **24-hour expiry hard-coded.** Per-tool overrides may be added later but v1 is uniform.
- **No re-confirmation.** Once denied or expired, the LLM must initiate a new tool_use to retry (with the operator's input).
- **Idempotent.** Multiple `block_actions` events for the same confirmation are ignored after the first response.
- **No silent fallthrough.** A pending confirmation cannot be bypassed by another tool call. The LLM is told "you have N pending confirmations" until they resolve, and may reason about the work without firing more high-blast tools.

## Failure modes

- **Slack signature failure** on the response — drop the event, log, no state change.
- **Confirmation row missing for action_id** — respond ephemerally to operator: "this confirmation expired or was already resolved"; no state change.
- **Crash during handler execution after approval** — the tool_call row remains in `confirmed` but no `result`; on restart, concierge-core surfaces a needs-you card "previously confirmed action did not complete: <tool_name>; retry?"
