---
id: ARCH-SDD-TRACEABILITY
type: architecture
domain: sdd-methodology
status: approved
version: 1
layer: 2
references: FUNC-SDD-SPEC-AUTHORING
---

# ARCH-SDD-TRACEABILITY — Cross-Layer Linking

## Overview

Traceability connects specs across layers and maps them to code and test files. It answers two questions: "which spec governs this file?" and "which files are affected by this spec change?"

## Mechanism

A single `traceability.yml` file at `.specify/traceability.yml`. Each entry is keyed by spec ID.

## Entry Structure

```yaml
SPEC-ID:
  parent: PARENT-SPEC-ID        # L2/L3 only — matches frontmatter references
  children: [CHILD-SPEC-IDS]    # convenience — derived from children's parent field
  code_paths: [file paths]      # L3 only — source files governed by this spec
  test_paths: [file paths]      # L3 only — test files that validate this spec
  status: draft|approved|deprecated
```

**Example:**

```yaml
FUNC-TASK-LIFECYCLE:
  children: [ARCH-TASK-MODEL]
  status: approved

ARCH-TASK-MODEL:
  parent: FUNC-TASK-LIFECYCLE
  children: [RAIL-TASK-MODEL]
  status: approved

RAIL-TASK-MODEL:
  parent: ARCH-TASK-MODEL
  code_paths: [app/models/task.rb]
  test_paths: [spec/models/task_spec.rb]
  status: draft
```

## Rules

- Every code file should trace back to a spec via an L3 entry's `code_paths`. Orphan code (no governing spec) is a smell.
- When a spec changes, traceability identifies all downstream impacts: children specs, governed code files, validation tests.
- Agents must update `traceability.yml` when creating new files or specs.
- Agents must check `traceability.yml` before editing any file to find its governing spec.
- The `children` field is a convenience — it is derived from children's `parent` field and should be kept in sync.
