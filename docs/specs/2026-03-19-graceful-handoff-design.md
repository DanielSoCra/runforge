# Graceful Handoff Design

**Date:** 2026-03-19
**Items covered:** WISC learning #1 — soft-kill / graceful handoff
**Spec IDs planned:** FUNC-AC-HANDOFF, ARCH-AC-HANDOFF, STACK-AC-HANDOFF-RUNTIME, STACK-AC-HANDOFF-COORDINATOR

---

## Problem

When an implementation attempt times out, the next attempt starts cold — no memory of what was tried, what failed, or how far the work got. Complex units pay this cost on every retry, re-discovering the same dead ends each time.

---

## L1 — Behavior

**Actors:** Operator

**Scenario: Approaching time limit**
- Given an implementation attempt is in progress
- When it approaches its time limit
- Then the system prompts it to record its current state before stopping

**Scenario: Retry inherits previous state**
- Given an implementation attempt was stopped before completing
- When the system starts a new attempt on the same unit
- Then the new attempt receives a summary of what the previous attempt learned

**Scenario: No prior state available**
- Given a previous attempt recorded no useful state
- When a new attempt starts
- Then it starts clean with no previous state injected

**Success Criteria:**
- Retry attempts for timed-out units begin oriented — with discoveries, dead ends, and a recommended first action from the previous attempt
- No operator intervention required to pass state between attempts

**Constraints:**
- The handoff record is advisory: the new attempt uses it as a starting point, not a binding contract
- Applies only to worker and fix-worker attempts — not classification, review, or reporting

---

## L2 — Architecture

**References:** FUNC-AC-HANDOFF

**Four components change:**

**Session Runtime** gains two-phase termination for worker and fix-worker session types only. At `timeout − 2min`, it injects a warning signal via the existing hook infrastructure. At `timeout`, it hard-terminates as today. After session end, it extracts structured handoff records from the session output alongside existing pitfall extraction. The handoff record is stored on the unit's execution state.

**Unit State** gains one new optional field: `handoff_note`. Populated when a timeout produces a handoff record; absent on clean completion or when the session produced no handoff output.

**Implementation Coordinator** reads `handoff_note` during context assembly for each unit attempt. If present, prepends it before spec content. No other changes to decomposition or merge logic.

**Worker session** prompt template gains a section describing the handoff record format and instructing the session to write one immediately upon receiving the timeout warning.

**Injection mechanism:** The warning is delivered via the PreToolUse hook infrastructure that both execution adapters already support. A time-aware hook blocks the tool call and delivers the warning message when elapsed time crosses the threshold — no new infrastructure needed.

---

## L3 — Key Decisions (TypeScript)

**References:** ARCH-AC-HANDOFF
**Code paths:** `src/session-runtime/`, `src/implementation/`

**Injection:** Time-aware PreToolUse hook checks elapsed time. If `Date.now() - sessionStartTime > timeoutMs - 120_000`, blocks the tool call and returns the warning message. SDK adapter: a new TypeScript callback hook alongside the existing containment hooks. CLI adapter: a new standalone shell script hook (separate from `containment.sh` — the CLI supports multiple PreToolUse hooks via the hooks array in configuration). Both follow the existing hook registration pattern in Session Runtime.

**Extraction pattern:**
```typescript
const HANDOFF_RE = /\[HANDOFF\]([\s\S]*?)\[\/HANDOFF\]/;
```
Runs alongside existing gotcha extraction in the session result parser. Empty or malformed blocks (no content between tags, or tags absent entirely) are treated as absent — `handoffNote` remains undefined and the next attempt starts clean.

**UnitState extension:**
```typescript
handoffNote?: string  // populated on timeout; absent on clean completion
```

**Context injection in coordinator:**
```typescript
if (unit.state.handoffNote) {
  context = `[PREVIOUS ATTEMPT]\n${unit.state.handoffNote}\n\n` + context;
}
```

**Handoff block format** (in worker prompt template):
```
[HANDOFF]
completed: <files created or modified so far>
state: <where you are in the implementation>
dead_ends: <approaches tried that failed and why>
next: <specific recommended first action for the next attempt>
[/HANDOFF]
```
