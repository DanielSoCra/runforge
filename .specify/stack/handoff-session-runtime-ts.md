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
  - packages/daemon/src/session-runtime/timeout-hook.ts
  - packages/daemon/src/session-runtime/index.ts
  - .claude/hooks/timeout-warning.sh
test_paths:
  - packages/daemon/src/session-runtime/timeout-hook.test.ts
  - packages/daemon/src/session-runtime/index.test.ts
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
if (!warned && Date.now() - startTime > timeoutMs - 120_000) {
  warned = true;
  return { block: true, message: TIMEOUT_WARNING_MESSAGE };
}
return { block: false };
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
- The tool call that triggers the warning is sacrificed — the hook returns `{ block: true }` which prevents it from executing. This is intentional: the warning takes the slot of one tool call, and the agent then uses subsequent calls (which pass through freely, since `warned` is now `true`) to write its handoff output.
- The `warned` flag must be scoped to the session instance — each session spawn must call `makeTimeoutHook` separately to create a new closure with its own `warned` state. A module-level singleton breaks concurrent sessions: a timeout in one silences the hook for all others in the same process.
