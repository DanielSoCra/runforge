> **🗄 HISTORICAL (2026-06-02).** Implementation-complete execution log, kept for provenance. The active design is `docs/specs/2026-03-19-enriched-commits-design.md`; the canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Enriched Commits — Spec Writing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write L1, L2, and L3 specs for the Enriched Commits feature — structured commit format that lets the Knowledge Service extract gotchas from implementation records at run completion.

**Architecture:** Workers commit in a structured format with `Why:`, `Discovered:`, `Dead-ends:`, and `Artifacts:` fields. At run completion, the Control Plane reads the feature branch's commit log and calls a new `parse_commits` operation on the Knowledge Service. Extracted gotchas enter the existing store via normal deduplication. Four spec files across three layers, plus traceability entries.

**Design doc:** `docs/specs/2026-03-19-enriched-commits-design.md`

**Guardian skills:** `l1-spec-guardian`, `l2-spec-guardian`, `l3-spec-guardian` — use these to validate each spec before committing.

---

## File Map

| Action | Path | ID |
|--------|------|----|
| Create | `.specify/functional/enriched-commits.md` | `FUNC-AC-ENRICHED-COMMITS` |
| Create | `.specify/architecture/enriched-commits.md` | `ARCH-AC-ENRICHED-COMMITS` |
| Create | `.specify/stack/enriched-commits-worker-ts.md` | `STACK-AC-ENRICHED-COMMITS-WORKER` |
| Create | `.specify/stack/enriched-commits-knowledge-ts.md` | `STACK-AC-ENRICHED-COMMITS-KNOWLEDGE` |
| Modify | `.specify/traceability.yml` | — |

---

## Task 1: Write L1 functional spec (FUNC-AC-ENRICHED-COMMITS)

**Files:**
- Create: `.specify/functional/enriched-commits.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/functional/enriched-commits.md` with exactly this content:

```markdown
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
```

- [ ] **Step 2: Self-check against L1 guardian rules**

Verify all of the following:
- [ ] YAML frontmatter has all 6 fields: `id`, `type`, `domain`, `status`, `version`, `layer`
- [ ] `layer` is integer `1`
- [ ] Title is `# FUNC-AC-ENRICHED-COMMITS — Enriched Implementation Records`
- [ ] Exactly 5 sections in order: Problem Statement, Actors, Behavior, Success Criteria, Constraints
- [ ] Every scenario uses Given/When/Then
- [ ] No system component names (Knowledge Service, Control Plane, Session Runtime, etc.)
- [ ] No tech terms: no "commit", "git", "regex", "parse", "JSON", "API"
- [ ] Actors are human roles only
- [ ] Constraints have no tech terms

Note: "implementation record" and "knowledge store" are acceptable domain language in this context — they describe business concepts, not implementation choices.

If anything fails, fix it before proceeding.

- [ ] **Step 3: Add traceability entry**

Add to `.specify/traceability.yml` under the Auto-Claude L1 section:

```yaml
FUNC-AC-ENRICHED-COMMITS:
  children: [ARCH-AC-ENRICHED-COMMITS]
  status: draft
```

Also add `FUNC-AC-ENRICHED-COMMITS` to the `children` list of `L0-AC-VISION`. The updated line looks like:

```yaml
  children: [FUNC-AC-PIPELINE, FUNC-AC-IMPLEMENTATION, FUNC-AC-QUALITY, FUNC-AC-SAFETY, FUNC-AC-BUG-TRIAGE, FUNC-AC-LEARNING, STACK-AC-CONVENTIONS, FUNC-AC-ENRICHED-COMMITS]
```

- [ ] **Step 4: Commit**

```bash
git add .specify/functional/enriched-commits.md .specify/traceability.yml
git commit -m "spec(l1): add FUNC-AC-ENRICHED-COMMITS enriched implementation records functional spec"
```

---

## Task 2: Write L2 architecture spec (ARCH-AC-ENRICHED-COMMITS)

**Files:**
- Create: `.specify/architecture/enriched-commits.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/architecture/enriched-commits.md` with exactly this content:

```markdown
---
id: ARCH-AC-ENRICHED-COMMITS
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-ENRICHED-COMMITS
---

# ARCH-AC-ENRICHED-COMMITS — Enriched Implementation Records Architecture

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
3. At run completion, Control Plane reads the commit history for the feature branch since the base branch.
4. Control Plane calls Knowledge Service `parse_commits` with the commit messages and work request identifier.
5. Knowledge Service parses each commit: extracts `Discovered:`, `Dead-ends:`, and `Artifacts:` fields.
6. For each extracted entry, Knowledge Service creates or updates a Gotcha using the artifact patterns from `Artifacts:`.
7. Standard deduplication applies: matching pattern + description increments hit count instead of creating a duplicate.
8. Extracted gotchas enter the standard injection, promotion, and archival lifecycle — no special handling.

## Error Handling

**Commit missing required fields:** Skip the commit silently. Log a count of skipped commits in the `parse_commits` response. Do not fail the run.

**`parse_commits` operation fails:** Log and continue. Knowledge extraction from commit history is non-critical. The run is already complete — the failure does not affect the run outcome or operator notification.

**Duplicate detection:** If a commit produces a gotcha with a pattern and description matching an existing entry, increment hit count only. The existing deduplication logic in Knowledge Service handles this without changes.
```

- [ ] **Step 2: Self-check against L2 guardian rules**

Verify all of the following:
- [ ] All 7 frontmatter fields present: `id`, `type`, `domain`, `status`, `version`, `layer`, `references`
- [ ] `layer` is integer `2`
- [ ] `references` is `FUNC-AC-ENRICHED-COMMITS`
- [ ] No forbidden frontmatter fields
- [ ] Exactly 6 sections in order: Overview, Data Model, API Contract, System Boundaries, Event Flows, Error Handling
- [ ] Data model uses plain language — no column types, FK constraints, or index definitions
- [ ] Event flows use system names only — no TypeScript, no file paths
- [ ] No framework/tool names (git, TypeScript, Node.js, regex, etc.)
- [ ] No file paths anywhere in the spec

- [ ] **Step 3: Update traceability**

Add to `.specify/traceability.yml` under the Auto-Claude L2 section:

```yaml
ARCH-AC-ENRICHED-COMMITS:
  parent: FUNC-AC-ENRICHED-COMMITS
  children: [STACK-AC-ENRICHED-COMMITS-WORKER, STACK-AC-ENRICHED-COMMITS-KNOWLEDGE]
  status: draft
```

- [ ] **Step 4: Commit**

```bash
git add .specify/architecture/enriched-commits.md .specify/traceability.yml
git commit -m "spec(l2): add ARCH-AC-ENRICHED-COMMITS enriched implementation records architecture spec"
```

---

## Task 3: Write L3 spec — Worker prompt format (STACK-AC-ENRICHED-COMMITS-WORKER)

**Files:**
- Create: `.specify/stack/enriched-commits-worker-ts.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/stack/enriched-commits-worker-ts.md` with exactly this content:

```markdown
---
id: STACK-AC-ENRICHED-COMMITS-WORKER
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-ENRICHED-COMMITS
code_paths:
  - prompts/worker.md
test_paths:
  - src/knowledge/parse-commits.test.ts
---

# STACK-AC-ENRICHED-COMMITS-WORKER — Enriched Commits: Worker Prompt Format

## Pattern

**Structured commit body fields** added to the worker prompt template. Workers already commit at the end of each unit — this extends the format with required fields. Format is enforced by prompt instruction, not by code. No parsing occurs at commit time.

## Key Decisions

**Single-line values for all fields.** Simplifies extraction regex and avoids ambiguity in multi-line commit bodies. Enforced in the prompt template: each field value must fit on one line.

**`Artifacts:` is the required anchor field.** Without artifact patterns, an extracted gotcha has no injection target and cannot be matched to future work. Commits missing `Artifacts:` are skipped by `parse_commits`. The prompt template marks `Artifacts:` as mandatory and the knowledge fields as strongly expected.

## Examples

Commit format (added to `prompts/worker.md`):

```
feat: <what changed>

Why: <spec decision or constraint that drove this approach>
Discovered: <non-obvious pattern, constraint, or gotcha found>
Dead-ends: <approach tried that failed and why>
Artifacts: src/services/auth/**/*.ts, src/models/user.ts
```

## Gotchas

- `Artifacts:` values must not contain commas within a single glob pattern — commas are the delimiter when splitting patterns. Standard glob patterns do not contain commas; this is a documentation concern, not a code concern.
- If a unit produces no non-obvious discoveries and hits no dead ends, the worker should still write `Why:` and `Artifacts:`. An absent or empty `Discovered:` produces no gotcha but keeps the commit parseable. Do not omit `Artifacts:` — a commit without it is entirely skipped.
- The prompt template should give a concrete example of each field, not just a description. Workers produce better output when they can see the target format directly.
```

- [ ] **Step 2: Self-check against L3 guardian rules**

Verify all of the following:
- [ ] All 9 frontmatter fields present
- [ ] `layer` is integer `3`
- [ ] `references` is `ARCH-AC-ENRICHED-COMMITS`
- [ ] File is in `.specify/stack/` not `flavors/`
- [ ] Exactly 4 sections in order: Pattern, Key Decisions, Examples, Gotchas
- [ ] Examples section shows the format without being a complete implementation
- [ ] No `parent` or `parent_spec` in frontmatter

- [ ] **Step 3: Update traceability**

Add to `.specify/traceability.yml`:

```yaml
STACK-AC-ENRICHED-COMMITS-WORKER:
  parent: ARCH-AC-ENRICHED-COMMITS
  children: []
  code_paths:
    - prompts/worker.md
  test_paths:
    - src/knowledge/parse-commits.test.ts
  status: draft
```

- [ ] **Step 4: Commit**

```bash
git add .specify/stack/enriched-commits-worker-ts.md .specify/traceability.yml
git commit -m "spec(l3): add STACK-AC-ENRICHED-COMMITS-WORKER worker commit format patterns"
```

---

## Task 4: Write L3 spec — Knowledge Service & Control Plane (STACK-AC-ENRICHED-COMMITS-KNOWLEDGE)

**Files:**
- Create: `.specify/stack/enriched-commits-knowledge-ts.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/stack/enriched-commits-knowledge-ts.md` with exactly this content:

```markdown
---
id: STACK-AC-ENRICHED-COMMITS-KNOWLEDGE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-ENRICHED-COMMITS
code_paths:
  - src/knowledge/parse-commits.ts
  - src/control-plane/completion.ts
test_paths:
  - src/knowledge/parse-commits.test.ts
  - src/control-plane/completion.test.ts
---

# STACK-AC-ENRICHED-COMMITS-KNOWLEDGE — Enriched Commits: Knowledge Service & Control Plane (TypeScript)

## Pattern

**Regex field extraction** from structured commit message bodies in a standalone parse module. Each commit is parsed independently. Extracted entries create or update Gotchas via the existing `storeGotcha` path. The Control Plane reads the commit log at run completion using a separator-delimited git format.

## Key Decisions

**Standalone module** (`src/knowledge/parse-commits.ts`) rather than inlined in the Knowledge Service class. The parser takes string input and returns Gotcha data — no service dependencies. This makes it independently testable without mocking the Knowledge Service.

**Separator-delimited git log format** (`--format=%B---COMMIT---`) rather than structured git format. Simpler to split and more reliable than line-by-line parsing when commit bodies contain newlines.

## Examples

```typescript
// src/knowledge/parse-commits.ts — field extraction
const ARTIFACTS_RE = /^Artifacts:\s*(.+)$/m;
const DISCOVERED_RE = /^Discovered:\s*(.+)$/m;
const DEAD_ENDS_RE = /^Dead-ends:\s*(.+)$/m;
```

```typescript
// src/control-plane/completion.ts — reading commit log
const log = await git(['log', '--format=%B---COMMIT---', `${baseBranch}..${featureBranch}`]);
const messages = log.split('---COMMIT---').filter(s => s.trim().length > 0);
```

## Gotchas

- `git log A..B` returns empty output when A and B are the same commit (no new commits). Check for an empty `messages` array before calling `parse_commits` — this is expected after simple fast-forward merges, not an error.
- Merge commit bodies typically lack the structured fields and will be skipped silently — correct behavior, not a bug.
- Split `Artifacts:` on `,` then trim each segment: `value.split(',').map(s => s.trim()).filter(Boolean)`. This handles trailing commas and extra whitespace from worker output without producing empty artifact patterns.
- `parse_commits` failure must not affect run completion or operator notification. Wrap the call in a try/catch at the Control Plane callsite and log the error without re-throwing.
```

- [ ] **Step 2: Self-check against L3 guardian rules**

Same checklist as previous L3 tasks — verify all 9 frontmatter fields, correct layer/references/stack, file in `.specify/stack/`, 4 sections, examples are 3–5 lines each.

- [ ] **Step 3: Update traceability**

Add to `.specify/traceability.yml`:

```yaml
STACK-AC-ENRICHED-COMMITS-KNOWLEDGE:
  parent: ARCH-AC-ENRICHED-COMMITS
  children: []
  code_paths:
    - src/knowledge/parse-commits.ts
    - src/control-plane/completion.ts
  test_paths:
    - src/knowledge/parse-commits.test.ts
    - src/control-plane/completion.test.ts
  status: draft
```

- [ ] **Step 4: Commit**

```bash
git add .specify/stack/enriched-commits-knowledge-ts.md .specify/traceability.yml
git commit -m "spec(l3): add STACK-AC-ENRICHED-COMMITS-KNOWLEDGE parse_commits and completion patterns"
```
