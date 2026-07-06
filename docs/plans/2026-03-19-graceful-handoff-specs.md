> **🗄 HISTORICAL (2026-06-02).** Implementation-complete execution log, kept for provenance. The active design is `docs/specs/2026-03-19-graceful-handoff-design.md`; the canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Graceful Handoff — Spec Writing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write L1, L2, and L3 specs for the Graceful Handoff feature — two-phase session termination that passes state between timed-out implementation attempts.

**Architecture:** Session Runtime gains a time-aware PreToolUse hook that warns sessions approaching timeout. Sessions write a structured `[HANDOFF]` block; Session Runtime extracts it; Implementation Coordinator injects it into the next attempt's context. Four spec files across three layers, plus traceability entries.

**Design doc:** `docs/specs/2026-03-19-graceful-handoff-design.md`

**Guardian skills:** `l1-spec-guardian`, `l2-spec-guardian`, `l3-spec-guardian` — use these to validate each spec before committing.

---

## File Map

| Action | Path | ID |
|--------|------|----|
| Create | `.specify/functional/graceful-handoff.md` | `FUNC-AC-HANDOFF` |
| Create | `.specify/architecture/graceful-handoff.md` | `ARCH-AC-HANDOFF` |
| Create | `.specify/stack/handoff-session-runtime-ts.md` | `STACK-AC-HANDOFF-RUNTIME` |
| Create | `.specify/stack/handoff-coordinator-ts.md` | `STACK-AC-HANDOFF-COORDINATOR` |
| Modify | `.specify/traceability.yml` | — |

---

## Task 1: Write L1 functional spec (FUNC-AC-HANDOFF)

**Files:**
- Create: `.specify/functional/graceful-handoff.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/functional/graceful-handoff.md` with exactly this content:

```markdown
---
id: FUNC-AC-HANDOFF
type: functional
domain: runforge
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
```

- [ ] **Step 2: Self-check against L1 guardian rules**

Verify all of the following before continuing:
- [ ] YAML frontmatter has all 6 fields: `id`, `type`, `domain`, `status`, `version`, `layer`
- [ ] `layer` is integer `1` (not string `"L1"`)
- [ ] Title is `# FUNC-AC-HANDOFF — Graceful Handoff Between Attempts`
- [ ] Exactly 5 sections in order: Problem Statement, Actors, Behavior, Success Criteria, Constraints
- [ ] Every scenario uses Given/When/Then
- [ ] No system component names (Session Runtime, Knowledge Service, etc.) anywhere in the file
- [ ] No tech terms: no "hook", "regex", "timeout", "TypeScript", "JSON", "session"
- [ ] Actors section lists only human roles
- [ ] Constraints section has no tech terms

If anything fails the checklist, fix it before proceeding.

- [ ] **Step 3: Add traceability entry**

Add to `.specify/traceability.yml` under the Runforge L1 section:

```yaml
FUNC-AC-HANDOFF:
  children: [ARCH-AC-HANDOFF]
  status: draft
```

Also add `FUNC-AC-HANDOFF` to the `children` list of `L0-AC-VISION`.

- [ ] **Step 4: Commit**

```bash
git add .specify/functional/graceful-handoff.md .specify/traceability.yml
git commit -m "spec(l1): add FUNC-AC-HANDOFF graceful handoff functional spec"
```

---

## Task 2: Write L2 architecture spec (ARCH-AC-HANDOFF)

**Files:**
- Create: `.specify/architecture/graceful-handoff.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/architecture/graceful-handoff.md` with exactly this content:

```markdown
---
id: ARCH-AC-HANDOFF
type: architecture
domain: runforge
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

- Session Runtime OWNS: handoff record extraction, two-phase termination signaling for worker and fix-worker session types.
- Implementation Coordinator OWNS: handoff record injection into unit context, unit execution state (including the handoff record field).
- The handoff record is transient per-unit state. It is not stored in the results ledger and does not affect knowledge accumulation in the Knowledge Service.

## Event Flows

1. Session Runtime detects that a worker or fix-worker session has consumed `timeout − 2min` of its allowed time.
2. Session Runtime delivers a warning signal to the running session via a time-aware hook in the existing hook infrastructure.
3. The session writes a structured handoff record to its output and stops making further tool calls.
4. At session termination, Session Runtime extracts the handoff record from session output alongside existing pitfall marker extraction.
5. Session Runtime stores the handoff record on the unit's execution state.
6. Implementation Coordinator reads the unit's execution state when preparing the next attempt.
7. If a handoff record is present, Implementation Coordinator prepends it before spec content in the assembled context.
8. If no handoff record is present (empty, malformed, or absent), the next attempt begins with the standard context — identical to behavior before this feature.

## Error Handling

**Session produces no handoff block:** Treat as absent. Next attempt starts clean with no previous state. Behavior is identical to pre-feature behavior.

**Session produces malformed handoff block (empty content between delimiters):** Treat as absent. Log a warning but do not affect the attempt.

**Handoff record present but next attempt completes cleanly:** No special handling. The handoff record is advisory and is discarded after the attempt completes successfully.
```

- [ ] **Step 2: Self-check against L2 guardian rules**

Verify all of the following:
- [ ] All 7 frontmatter fields present: `id`, `type`, `domain`, `status`, `version`, `layer`, `references`
- [ ] `layer` is integer `2`
- [ ] `references` is `FUNC-AC-HANDOFF`
- [ ] No forbidden frontmatter fields (`stack`, `code_paths`, `test_paths`, `title`)
- [ ] Exactly 6 sections in order: Overview, Data Model, API Contract, System Boundaries, Event Flows, Error Handling
- [ ] Data model uses plain language, no column/FK/index definitions
- [ ] Event flows use system names only (Session Runtime, Implementation Coordinator) — no TypeScript, no file paths
- [ ] No framework names (TypeScript, Node.js, Docker, etc.)
- [ ] No file paths anywhere in the spec
- [ ] No `traceability` block inside the spec

If anything fails, fix it before proceeding.

- [ ] **Step 3: Update traceability**

Add to `.specify/traceability.yml` under the Runforge L2 section:

```yaml
ARCH-AC-HANDOFF:
  parent: FUNC-AC-HANDOFF
  children: [STACK-AC-HANDOFF-RUNTIME, STACK-AC-HANDOFF-COORDINATOR]
  status: draft
```

- [ ] **Step 4: Commit**

```bash
git add .specify/architecture/graceful-handoff.md .specify/traceability.yml
git commit -m "spec(l2): add ARCH-AC-HANDOFF graceful handoff architecture spec"
```

---

## Task 3: Write L3 spec — Session Runtime changes (STACK-AC-HANDOFF-RUNTIME)

**Files:**
- Create: `.specify/stack/handoff-session-runtime-ts.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/stack/handoff-session-runtime-ts.md` with exactly this content:

```markdown
---
id: STACK-AC-HANDOFF-RUNTIME
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-HANDOFF
code_paths:
  - src/session-runtime/timeout-hook.ts
  - src/session-runtime/index.ts
  - .claude/hooks/timeout-warning.sh
test_paths:
  - src/session-runtime/timeout-hook.test.ts
  - src/session-runtime/index.test.ts
---

# STACK-AC-HANDOFF-RUNTIME — Graceful Handoff: Session Runtime (TypeScript)

## Pattern

**Time-aware PreToolUse hook** alongside existing containment hooks. The hook checks elapsed session time before each tool call and delivers a warning message when the threshold is crossed. Handoff extraction reuses the same output-parsing pass as gotcha extraction — no new I/O needed.

## Key Decisions

**Separate hook file** (`timeout-hook.ts`) rather than modifying `containment-hooks.ts`. The containment hook has a different responsibility (path and content blocking). Coupling time-tracking to it would merge two unrelated concerns. Both adapters register hooks from an array — adding a second hook requires no structural change.

**CLI adapter**: new standalone shell script (`.claude/hooks/timeout-warning.sh`), separate from `containment.sh`. The Claude Code CLI hooks configuration array supports multiple PreToolUse hooks.

**One-shot warning**: the hook activates once per session. After delivering the warning, it stops blocking subsequent tool calls so the session can write its handoff output without interference.

## Examples

```typescript
// src/session-runtime/timeout-hook.ts
export function makeTimeoutHook(startTime: number, timeoutMs: number) {
  let warned = false;
  return (_toolName: string): { block: boolean; message?: string } => {
    if (!warned && Date.now() - startTime > timeoutMs - 120_000) {
      warned = true;
      return { block: true, message: TIMEOUT_WARNING_MESSAGE };
    }
    return { block: false };
  };
}
```

```typescript
// src/session-runtime/index.ts — handoff extraction (alongside gotcha extraction)
const HANDOFF_RE = /\[HANDOFF\]([\s\S]*?)\[\/HANDOFF\]/;
const match = output.match(HANDOFF_RE);
const handoffNote = match?.[1]?.trim() || undefined;
```

## Gotchas

- The hook fires on every tool call. Check time before any other logic to keep it fast — no string operations unless the threshold is crossed.
- For the CLI adapter, pass `SESSION_START_TIME` as an environment variable in the session spawn options. Add it to the explicit `safeEnv` allowlist alongside `PATH` and `HOME` — do not pass `process.env` wholesale.
- Empty handoff blocks (`[HANDOFF][/HANDOFF]`) match the regex but produce an empty string after `.trim()`. Treat as `undefined`, not as a valid handoff.
- `UnitState` is serialized to disk for crash resumption. Ensure `handoffNote?: string` is included in the Zod schema (or equivalent validation schema) for `UnitState` — otherwise deserialization silently drops it on restart.
```

- [ ] **Step 2: Self-check against L3 guardian rules**

Verify all of the following:
- [ ] All 9 frontmatter fields present: `id`, `type`, `domain`, `status`, `version`, `layer`, `stack`, `references`, `code_paths`, `test_paths`
- [ ] `layer` is integer `3`
- [ ] `references` is `ARCH-AC-HANDOFF`
- [ ] `stack` is `typescript`
- [ ] File is in `.specify/stack/` not `flavors/`
- [ ] ID is `STACK-AC-HANDOFF-RUNTIME` (not `STACK-AC-HANDOFF-RUNTIME-TS`)
- [ ] Exactly 4 sections in order: Pattern, Key Decisions, Examples, Gotchas
- [ ] Pattern section names the pattern and explains why
- [ ] Examples are 3–5 lines each, not complete implementations
- [ ] No forbidden frontmatter fields (`parent`, `parent_spec`, `title`)

- [ ] **Step 3: Update traceability**

Add to `.specify/traceability.yml` under the Runforge L3 section:

```yaml
STACK-AC-HANDOFF-RUNTIME:
  parent: ARCH-AC-HANDOFF
  children: []
  code_paths:
    - src/session-runtime/timeout-hook.ts
    - src/session-runtime/index.ts
    - .claude/hooks/timeout-warning.sh
  test_paths:
    - src/session-runtime/timeout-hook.test.ts
    - src/session-runtime/index.test.ts
  status: draft
```

- [ ] **Step 4: Commit**

```bash
git add .specify/stack/handoff-session-runtime-ts.md .specify/traceability.yml
git commit -m "spec(l3): add STACK-AC-HANDOFF-RUNTIME session runtime handoff patterns"
```

---

## Task 4: Write L3 spec — Implementation Coordinator changes (STACK-AC-HANDOFF-COORDINATOR)

**Files:**
- Create: `.specify/stack/handoff-coordinator-ts.md`

- [ ] **Step 1: Write the spec file**

Write `.specify/stack/handoff-coordinator-ts.md` with exactly this content:

```markdown
---
id: STACK-AC-HANDOFF-COORDINATOR
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-HANDOFF
code_paths:
  - src/implementation/types.ts
  - src/implementation/coordinator.ts
test_paths:
  - src/implementation/coordinator.test.ts
---

# STACK-AC-HANDOFF-COORDINATOR — Graceful Handoff: Implementation Coordinator (TypeScript)

## Pattern

**Optional field injection** in context assembly. The coordinator reads `handoffNote` from the unit's prior execution state and prepends it as a labeled block before spec content. No new abstraction — one conditional prepend in the existing context assembly function.

## Key Decisions

**`handoffNote?: string` on `UnitState`** rather than a separate store. The handoff is transient per-unit state that does not need to survive beyond the next attempt. Keeping it on `UnitState` makes it available wherever `UnitState` is passed, and it serializes alongside the existing crash-resumption state automatically.

**Prepend before spec content** (not append). The new session needs orientation before actionable instructions — the handoff establishes context, the spec provides direction.

**Clear after successful completion.** A successful attempt produces new state; the prior handoff is stale and should not influence subsequent related work.

## Examples

```typescript
// src/implementation/types.ts
interface UnitState {
  // ... existing fields
  handoffNote?: string;
}
```

```typescript
// src/implementation/coordinator.ts — context assembly
function assembleUnitContext(unit: Unit, state: UnitState): string {
  const prefix = state.handoffNote
    ? `[PREVIOUS ATTEMPT]\n${state.handoffNote}\n\n`
    : '';
  return prefix + unit.assembledContext;
}
```

## Gotchas

- `UnitState` is written to disk as part of crash-resumption checkpoints. Verify the Zod schema (or equivalent) for `UnitState` includes `handoffNote: z.string().optional()` — otherwise it is silently dropped on deserialization and the next attempt starts cold even when a handoff exists.
- After a unit completes successfully, set `state.handoffNote = undefined` before writing the checkpoint. A stale handoff from a previous partial attempt should not be injected into future work on related units.
```

- [ ] **Step 2: Self-check against L3 guardian rules**

Same checklist as Task 3 — verify all 9 frontmatter fields, correct layer/references/stack, file in `.specify/stack/`, 4 sections, examples are 3–5 lines.

- [ ] **Step 3: Update traceability**

Add to `.specify/traceability.yml`:

```yaml
STACK-AC-HANDOFF-COORDINATOR:
  parent: ARCH-AC-HANDOFF
  children: []
  code_paths:
    - src/implementation/types.ts
    - src/implementation/coordinator.ts
  test_paths:
    - src/implementation/coordinator.test.ts
  status: draft
```

- [ ] **Step 4: Commit**

```bash
git add .specify/stack/handoff-coordinator-ts.md .specify/traceability.yml
git commit -m "spec(l3): add STACK-AC-HANDOFF-COORDINATOR coordinator handoff patterns"
```
