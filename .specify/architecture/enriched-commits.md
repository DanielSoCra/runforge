---
id: ARCH-AC-ENRICHED-COMMITS
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-LEARNING
---

# ARCH-AC-ENRICHED-COMMITS — Enriched Implementation Records Architecture

> **Re-parented:** This L2 spec was originally under FUNC-AC-ENRICHED-COMMITS, which has been deprecated and merged into FUNC-AC-LEARNING v2 (section "Knowledge from Implementation Records").

## Overview

Worker sessions commit their work in a structured format that captures reasoning alongside the change. At run completion, the Control Plane reads the feature branch's commit history and passes it to the Knowledge Service, which extracts gotchas from the structured fields and stores them via the existing deduplication flow.

## Data Model

No new persistent entities. The structured commit message is ephemeral — its content is extracted into the existing **Gotcha** entity by the Knowledge Service. A commit message carries five fields: a one-line summary, a `Why:` field (the governing spec decision), a `Discovered:` field (non-obvious findings), a `Dead-ends:` field (failed approaches), and an `Artifacts:` field (glob patterns for the affected file areas). The `Artifacts:` field is the linkage that allows the Knowledge Service to match extracted gotchas to future work on the same areas.

## API Contract

**Knowledge Service — parse_commits (new operation):**
- Request: an array of commit message strings from a completed run; the source work request identifier
- Response: acknowledgment with count of gotchas stored and count of commits skipped (missing required fields or no extractable knowledge)
- Behavior: parses each message for structured fields; creates gotchas from `Discovered:` and `Dead-ends:` entries using patterns from `Artifacts:`; applies standard deduplication (same artifact pattern + description increments hit count, does not create a duplicate); commits missing `Artifacts:` or both knowledge fields are skipped silently

**Control Plane — run completion (extended):**
- Existing behavior: calls Knowledge Service to store exemplars
- Added behavior: reads commit history from the feature branch since the base branch; calls `parse_commits` with the commit messages and work request identifier
- No new trigger mechanism — reuses the existing completion event

## System Boundaries

- Worker session PRODUCES: structured commit messages (format enforced via prompt template, not by code)
- Control Plane READS: commit history from version control at run completion; CALLS: Knowledge Service `parse_commits`
- Knowledge Service OWNS: `parse_commits` operation; extraction, deduplication, and storage of commit-derived gotchas
- The existing gotcha injection, promotion, and archival flows are unchanged — commit-derived gotchas enter the same store as session-marker gotchas and follow the same lifecycle

## Event Flows

1. Worker session completes an assignment and commits the work using the structured format.
2. (Existing pipeline continues: review, holdout, integrate, deploy, test.)
3. At successful run completion (not stuck or escalated), Control Plane reads the commit history for the feature branch since the base branch.
4. Control Plane calls Knowledge Service `parse_commits` with the commit messages and work request identifier.
5. Knowledge Service parses each commit: extracts `Discovered:`, `Dead-ends:`, and `Artifacts:` fields.
6. For each extracted entry, Knowledge Service creates or updates a Gotcha using the artifact patterns from `Artifacts:`.
7. Standard deduplication applies: matching pattern + description increments hit count instead of creating a duplicate.
8. Extracted gotchas enter the standard injection, promotion, and archival lifecycle — no special handling.

## Error Handling

**Commit missing `Artifacts:` or missing both `Discovered:` and `Dead-ends:`:** Skip the commit silently. Log a count of skipped commits in the `parse_commits` response. Do not fail the run.

**`parse_commits` operation fails:** Log and continue. Knowledge extraction from commit history is non-critical. The run is already complete — the failure does not affect the run outcome or operator notification.

**Duplicate detection:** If a commit produces a gotcha with a pattern and description matching an existing entry, increment hit count only. The existing deduplication logic in Knowledge Service handles this without changes.
