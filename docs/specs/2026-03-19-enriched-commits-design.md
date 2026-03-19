# Enriched Commits Design

**Date:** 2026-03-19
**Items covered:** WISC learning #2 — enriched commit format + git-log as supplemental gotcha source
**Spec IDs planned:** FUNC-AC-ENRICHED-COMMITS, ARCH-AC-ENRICHED-COMMITS, STACK-AC-ENRICHED-COMMITS-WORKER, STACK-AC-ENRICHED-COMMITS-KNOWLEDGE

---

## Problem

When implementation work completes, the reasoning behind decisions, patterns discovered, and approaches that failed are lost. Future work on similar problems repeats the same discovery process. The commit history is an audit trail, not institutional memory.

---

## L1 — Behavior

**Actors:** Operator, Spec Author

**Scenario: Implementation record captures reasoning**
- Given an implementation unit completes
- When the work is committed to the record
- Then the record captures what changed, why the approach was chosen, what was discovered, and what approaches failed

**Scenario: Completed run contributes to institutional knowledge**
- Given a run completes successfully
- When the system processes the completion
- Then it extracts knowledge from the implementation record and adds it to the knowledge store

**Scenario: Future work benefits from past implementations**
- Given future work touches similar areas of the codebase
- When the system prepares context for that work
- Then knowledge from past implementations on those same areas is included

**Success Criteria:**
- Every implementation unit produces a record with sufficient reasoning to extract knowledge from
- Institutional knowledge accumulates across runs without requiring separate manual documentation
- Future work on similar file areas receives relevant knowledge from past work on those same areas

**Constraints:**
- Knowledge extracted from commit records supplements existing per-session knowledge capture — it does not replace it
- Knowledge from commit records requires operator approval before becoming permanent convention documentation
- Only successfully completed runs contribute commit-derived knowledge

---

## L2 — Architecture

**References:** FUNC-AC-ENRICHED-COMMITS

**Three components change:**

**Worker session** prompt template gains a structured commit message format. Workers already commit at the end of each unit — this adds required fields to the commit body: what changed, why (the spec decision), what was discovered, what approaches failed, and which artifact areas are affected. The artifact field is the key linkage: it gives the Knowledge Service the patterns needed to match this knowledge to future work.

**Knowledge Service** gains a `parse_commits` operation. Input: an array of commit message strings from a completed run. It parses the structured fields, creates gotchas from the discovered and dead-ends entries using artifact patterns from the commit, and stores them via the existing deduplication flow. Promoted gotchas are excluded from injection (already in permanent docs). Non-enriched commits (missing required fields) are skipped silently.

**Control Plane** adds one call at run completion alongside the existing exemplar storage call: reads the feature branch's commit history since the base branch and passes the commit messages to `parse_commits`. No new trigger mechanism or scheduling needed.

**Two channels, one store:** In-session markers (captured mid-execution) and commit-derived gotchas (captured at completion) both feed the same gotcha store with the same deduplication logic. They capture different signals — in-session markers reflect mid-flight observations; commit messages reflect retrospective reasoning after the work is done.

---

## L3 — Key Decisions (TypeScript)

**References:** ARCH-AC-ENRICHED-COMMITS
**Code paths:** `prompts/worker.md`, `src/knowledge/`, `src/control-plane/`

**Commit schema** (added to worker prompt template):
```
feat: <what changed>

Why: <spec decision or constraint that drove this approach>
Discovered: <non-obvious patterns, constraints, or gotchas found>
Dead-ends: <approaches tried that failed and why>
Artifacts: src/services/auth/**/*.ts, src/models/user.ts
```

**Commit history retrieval** (Control Plane at run completion):
```typescript
const log = await git(['log', '--format=%B---COMMIT---', `${baseBranch}..${featureBranch}`]);
const messages = log.split('---COMMIT---').filter(s => s.trim());
await knowledgeService.parseCommits(messages, workRequestId);
```

**parse_commits field extraction:**
```typescript
const DISCOVERED_RE = /^Discovered:\s*(.+)$/m;
const DEAD_ENDS_RE = /^Dead-ends:\s*(.+)$/m;
const ARTIFACTS_RE = /^Artifacts:\s*(.+)$/m;
// missing fields → skip commit silently
```

**Gotcha** — Each extracted entry (one from `Discovered:`, one from `Dead-ends:`) becomes a gotcha with:
- `artifactPatterns` from the `Artifacts:` field (split on `,`)
- `originType: 'autonomous'`
- `sourceWorkRequestId` from the caller
- Standard deduplication: if pattern + description already exists, increment hit count
