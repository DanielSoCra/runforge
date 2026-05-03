---
id: FUNC-CONCIERGE-MEMORY
type: functional
domain: concierge
status: draft
version: 1
layer: 1
---

# FUNC-CONCIERGE-MEMORY — Two-Tier Memory

## Problem Statement

A conversational assistant that helps the operator across days needs durable memory of decisions, captures, and stable preferences, and fast recall of recent operational context. A single store cannot serve both: durable memory must survive process restarts and remain curated by the operator; recent memory must be cheap to read in-loop without round-tripping the durable store. Two stores → two contracts.

## Actors

- **Operator** — the human; sole curator of durable knowledge.
- **Assistant** — reads both tiers; writes ephemeral records directly; writes durable records only on operator request or via the nightly consolidation job, and only into allow-listed locations.
- **Consolidator** — a scheduled job that promotes ephemeral activity into a durable summary.

## Behavior

### Durable memory

**Scenario: Operator asks the assistant to remember something**
- Given the operator says "remember X" (or equivalent intent)
- When the assistant evaluates the request
- Then the assistant proposes the durable record (location, summary, content) for operator approval
- And on operator approval → the record is added to the durable store
- And on operator denial → no record is added

**Scenario: Nightly consolidation**
- Given a 24-hour period of conversation and capability activity has elapsed
- When the consolidator runs
- Then a structured summary of the period is added to the durable store at the operator's daily-summary location
- And the summary does not require operator approval, because no client-sensitive content is included

**Scenario: Assistant tries to write to a sensitive location**
- Given the proposed durable write target is under the operator's client area
- When the write is requested
- Then the Confirmation Gate is invoked regardless of the assistant's prior reasoning
- And only on operator approval does the write proceed

**Scenario: Assistant tries to write outside the allow-list**
- Given the proposed durable write target is not on the allow-list
- When the write is requested
- Then the request is rejected at policy level with a clear reason returned to the assistant
- And no operator confirmation is shown

### Recent memory

**Scenario: Assistant assembles context for a turn**
- Given a current conversation turn is being prepared
- When the assistant assembles its working context
- Then the current conversation history and a precomputed compressed summary of recent activity are available
- And queries against older content fall back to the durable store

**Scenario: Capability invocation**
- Given a capability is invoked
- When the invocation resolves
- Then a record of the invocation (what was asked, what was returned in summary, how long it took, status) is appended to the recent activity log

**Scenario: Recent activity retention**
- Given a recent activity record is older than 30 days
- When the consolidator runs
- Then the raw record is removed
- And the durable summary written by earlier consolidator runs continues to represent it

### Recoverable compression

**Scenario: Capability returns a large result**
- Given a capability returns a result larger than the in-context budget
- When the result is folded into the assistant's working context
- Then the bulk content is replaced with a handle (a stable reference) plus a short description
- And the assistant can re-fetch the bulk content if needed

## Constraints

- **Two-tier separation is non-negotiable.** Durable memory holds curated, lasting knowledge; recent memory holds operational records bounded by retention.
- **Allow-list enforcement.** Durable writes outside an explicitly enumerated set of locations are rejected at policy level.
- **Sensitive-location confirmation.** Writes targeting client-sensitive areas always invoke the Confirmation Gate.
- **No lossy summarisation of audit-grade records.** The recent activity log is the authoritative answer to "what did the assistant do?"; summaries derived from it may be lossy but must not replace it.

## Success Criterion

1. "Remember X" results in a durable record the operator can find tomorrow.
2. "What did we do yesterday?" returns a meaningful answer without requiring a query into the durable store.
3. The assistant never writes outside the allow-list.
4. Recent activity older than 30 days disappears from raw form; its summary persists.

## Out of Scope

- Cross-device or cross-vault sync.
- Automated recall beyond explicit durable records and recent activity.
- Operator-facing memory inspection beyond normal access to durable records.
- Memory tiers beyond the two specified.
