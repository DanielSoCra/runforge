---
id: STACK-AC-HANDOFF-COORDINATOR
type: stack-specific
domain: auto-claude
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
