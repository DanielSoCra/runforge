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

Minimal valid commit (no discoveries or dead-ends):

```
feat: <what changed>

Why: <spec decision>
Artifacts: src/services/auth/**/*.ts
```

## Gotchas

- `Artifacts:` values must not contain commas within a single glob pattern — commas are the delimiter when splitting patterns. Standard glob patterns do not contain commas; this is a documentation concern, not a code concern.
- Commits missing `Artifacts:` are skipped entirely — including `Why:` content. The `Why:` field documents rationale but is not extracted into the gotcha store. Skipping the commit on missing `Artifacts:` is intentional: without artifact patterns, extracted gotchas have no injection target.
- If a unit produces no non-obvious discoveries and hits no dead ends, the worker should still write `Why:` and `Artifacts:`. An absent or empty `Discovered:` produces no gotcha but keeps the commit parseable. Do not omit `Artifacts:` — a commit without it is entirely skipped.
- The prompt template should give a concrete example of each field, not just a description. Workers produce better output when they can see the target format directly.
