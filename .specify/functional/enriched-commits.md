---
id: FUNC-AC-ENRICHED-COMMITS
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-ENRICHED-COMMITS — Enriched Implementation Records

## Problem Statement

When implementation work completes, the reasoning behind decisions, patterns discovered, and approaches that failed are not retained. Future work on similar problems repeats the same discovery process. The record of completed work is an audit trail, not institutional memory.

## Actors

- **Operator** — reviews and approves institutional knowledge before it becomes permanent
- **Spec Author** — benefits from accumulated knowledge when submitting future work

## Behavior

**Scenario: Implementation record captures reasoning**
- Given an implementation assignment completes
- When the work is committed to the record
- Then the record captures what changed, why the approach was chosen, what was discovered, and what approaches failed

**Scenario: Completed run contributes to institutional knowledge**
- Given a run completes successfully
- When the system processes the completion
- Then it extracts knowledge from the implementation records and adds it to the knowledge store

**Scenario: Future work benefits from past implementations**
- Given future work touches similar areas of the codebase
- When the system prepares context for that work
- Then knowledge from past implementations on those same areas is included

## Success Criteria

- Every implementation assignment produces a record containing sufficient reasoning to extract knowledge from
- Institutional knowledge accumulates across runs without requiring separate manual documentation
- Future work on similar areas receives relevant knowledge from past work on those same areas

## Constraints

- Knowledge extracted from implementation records supplements existing per-session knowledge capture — it does not replace it
- Extracted knowledge requires operator approval before becoming permanent convention documentation
- Only successfully completed runs contribute knowledge from their implementation records
