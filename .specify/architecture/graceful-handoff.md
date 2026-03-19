---
id: ARCH-AC-HANDOFF
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-HANDOFF
---

# ARCH-AC-HANDOFF — Graceful Handoff Architecture

## Overview

When a worker or fix-worker session approaches its time limit, the Session Runtime delivers a warning signal via the existing hook infrastructure, prompting the session to write a structured handoff record before terminating. The record is extracted from session output, stored on the unit's execution state, and prepended to the next attempt's assembled context by the Implementation Coordinator.

## Data Model

A **HandoffRecord** is an optional field on a Unit's execution state. It contains: a summary of completed work (which artifact locations were modified), the current implementation state (where in the task the session reached), dead ends (approaches tried that failed and why), and a recommended next action. A HandoffRecord is absent when the session completed cleanly, when the session produced no handoff output, or when the handoff block was empty.

## API Contract

No new external API operations. Changes to existing internal operations:

**Session Runtime — spawn session:** Response extended with an optional handoff record field, extracted from session output alongside existing pitfall marker extraction.

**Implementation Coordinator — assemble unit context:** When assembling context for a unit attempt, if the unit's execution state contains a handoff record from a previous attempt, prepend it as a labeled block before the spec content block.

## System Boundaries

- Session Runtime OWNS: handoff record extraction from session output, two-phase termination signaling for worker and fix-worker session types. Session Runtime returns the extracted handoff record in the session result; it does not write to unit execution state.
- Implementation Coordinator OWNS: handoff record injection into unit context, unit execution state (including the handoff record field).
- The handoff record is transient per-unit state. It is not stored in the results ledger and does not affect knowledge accumulation in the Knowledge Service.

## Event Flows

1. Session Runtime detects that a worker or fix-worker session has consumed `timeout − 2min` of its allowed time.
2. Session Runtime delivers a warning signal to the running session via a time-aware hook in the existing hook infrastructure.
3. The session writes a structured handoff record to its output and stops making further tool calls.
4. At session termination, Session Runtime extracts the handoff record from session output alongside existing pitfall marker extraction.
5. Session Runtime returns the handoff record in the session result (alongside cost, pitfall markers, and exit status).
6. Implementation Coordinator receives the session result, stores the handoff record on the unit's execution state, then reads it when preparing the next attempt.
7. If a handoff record is present, Implementation Coordinator prepends it before spec content in the assembled context.
8. If no handoff record is present (empty, malformed, or absent), the next attempt begins with the standard context — identical to behavior before this feature.

## Error Handling

**Session produces no handoff block:** Treat as absent. Next attempt starts clean with no previous state. Behavior is identical to pre-feature behavior.

**Session produces malformed handoff block (empty content between delimiters):** Treat as absent. Log a warning but do not affect the attempt.

**Handoff record present but next attempt completes cleanly:** No special handling. The handoff record is advisory and is discarded after the attempt completes successfully.
