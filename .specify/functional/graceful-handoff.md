---
id: FUNC-AC-HANDOFF
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-HANDOFF — Graceful Handoff Between Attempts

## Problem Statement

When an implementation attempt runs out of time, the next attempt starts with no memory of what was tried, what failed, or how far the work got. Complex assignments pay this cost on every retry, re-discovering the same dead ends each time.

## Actors

- **Operator** — configures the system and monitors results

## Behavior

**Scenario: Approaching time limit**
- Given an implementation attempt is in progress
- When it approaches its time limit
- Then the system prompts it to record its current state before stopping

**Scenario: Retry inherits previous state**
- Given an implementation attempt was stopped before completing
- When the system starts a new attempt on the same assignment
- Then the new attempt receives a summary of what the previous attempt learned

**Scenario: No prior state available**
- Given a previous attempt recorded no useful state
- When a new attempt starts
- Then it starts clean with no previous state injected

## Success Criteria

- Retry attempts for assignments that ran out of time begin with the previous attempt's discoveries, dead ends, and a recommended first action
- No operator intervention is required to pass state between attempts

## Constraints

- The handoff record is advisory: the new attempt uses it as a starting point, not a binding contract
- Applies only to worker and fix-worker attempts — not classification, review, or reporting
