---
id: FUNC-CONCIERGE-AWARENESS
type: functional
domain: concierge
status: deprecated
deprecated_by: FUNC-AC-OPERATOR-LEARNING
deprecation_date: 2026-06-02
deprecation_reason: Event-awareness / relevance-surfacing folded into the unified platform's behavioral-learning + fleet inbox specs per spec-reconciliation-ledger (2026-05-29).
version: 1
layer: 1
---

> **⛔ DEPRECATED (2026-06-02).** The event-awareness / relevance-surfacing behavior specified here is now canonically covered by the unified platform specs **FUNC-AC-OPERATOR-LEARNING** (attention/relevance learning) and **FUNC-AC-FLEET** (focus-gated cross-deployment inbox). Retained for history; the canonical specs in `.specify/` govern. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`.

# FUNC-CONCIERGE-AWARENESS — Activity Awareness

> **DISPOSITION — FOLD-IN (ratified 2026-06-24, decision `concierge-vs-platform`).** Consistent with the existing deprecation above: this spec folds into the one operations-OS platform under platform L0 **L0-AC-VISION** (the separate concierge L0 `L0-CONCIERGE-VISION`, `.specify/L0-vision.md`, is deprecated). **Live-behavior mapping:** read-on-demand activity awareness feeds the platform's **operator surface** (**FUNC-AC-OPERATOR-SURFACE**) + **decision inbox** (**FUNC-AC-DECISION-ESCALATION** / **FUNC-AC-FLEET**), with what-surfaces relevance owned by **FUNC-AC-OPERATOR-LEARNING**. **This is a disposition marker, not a reconciliation:** no content is deleted; the two-vision conflict is surfaced pending the tracked follow-on. Status stays `deprecated`.

## Problem Statement

The operator performs work outside the assistant, sometimes in parallel with the assistant's own activity. The assistant must be able to answer "what is happening on this machine right now?" without nagging the operator about the operator's own work, and without inventing context.

## Actors

- **Observer** — emits events about activity occurring around the assistant.
- **Assistant** — queries the observer when it needs awareness; never receives unsolicited push from the observer.
- **Activity** — a discrete occurrence the operator might care about, such as a new unit of work, a completed change, or a status change in ongoing work.

## Behavior

### Watch scope

**Scenario: Observer starts**
- Given the observer is launched
- When it initialises
- Then it adopts the operator-approved observation scope and the categories of activity to exclude.

**Scenario: Allow-listed activity**
- Given activity occurs in a watched area
- When the activity matches the watch criteria
- Then the observer emits a structured event with metadata only (never content)

**Scenario: Excluded category within a watched area**
- Given activity belongs to a sensitive excluded category within a watched area
- When the activity occurs
- Then no event is emitted

**Scenario: Activity outside the watched scope**
- Given activity occurs in an area not on the operator-approved scope
- When the activity occurs
- Then no event is emitted (the observer is not watching it)

### Read-on-demand

**Scenario: Assistant asks "what has happened recently?"**
- Given the assistant invokes the recent-activity capability with a time window
- When the observer responds
- Then a structured summary of events from that window is returned, grouped by area and type

**Scenario: Assistant asks for a status snapshot**
- Given the assistant invokes the status-snapshot capability
- When the observer responds
- Then a recent-enough status snapshot is returned according to the operator-approved freshness target.

### Privacy

**Scenario: Sensitive excluded category**
- Given activity belongs to a sensitive excluded category
- When the activity occurs
- Then no event is emitted, and no record persists

## Constraints

- **Write-only.** The observer emits events. It never warns the operator, never originates a message of its own, never invokes capabilities, never changes anything outside itself.
- **Allow-list only.** The observer watches only what the operator has explicitly enumerated.
- **Exclusion rules always applied.** Sensitive categories are filtered before any event reaches downstream consumers.
- **Metadata only.** Event payloads carry references and short fields, never file contents.
- **Bounded retention.** Events older than the configured window are removed; recent events remain queryable.

## Success Criterion

1. The operator's manual work never causes a notification, message, or alert from the assistant.
2. The assistant can answer "what is happening?" with an accurate, recent snapshot in well under a second.
3. Sensitive activity never appears in any event record.
4. A restart loses at most the most recent unsaved activity.

## Out of Scope

- Watching anything outside the allow-list, including general filesystem activity.
- Long-term analytics over operator behaviour.
- Detecting in-progress (uncommitted) work; only completed activity is observable.
- Network-level observation.
- Active responses (the observer does not act).
