---
id: STACK-AC-PIPELINE-DISPATCH
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-PIPELINE-DISPATCH
code_paths:
  - packages/daemon/src/pipeline-dispatch/
  - packages/daemon/src/pipeline-dispatch/dispatch.ts
  - packages/daemon/src/pipeline-dispatch/session-types.ts
  - packages/daemon/src/pipeline-dispatch/fallback.ts
test_paths:
  - packages/daemon/src/pipeline-dispatch/**/*.test.ts
---

# STACK-AC-PIPELINE-DISPATCH — Pipeline Session Dispatch (TypeScript)

## Pattern

**Registry pattern for session type mapping.** A static registry maps each pipeline work type (l2-brainstorm, l3-generate, compliance-review, implementation) to an AgentDefinition. The registry is a plain `Record<PipelineWorkType, AgentDefinition>` — no dynamic registration, no runtime mutation. Loaded once at daemon startup from config, frozen with `Object.freeze`.

**Request/Result value objects for dispatch communication.** `DispatchRequest` and `DispatchResult` are plain typed objects — no classes, no methods. The orchestration script constructs a request, the Session Runtime returns a result. Serialization is free (JSON-compatible by construction).

**Fallback pattern for transition safety.** When Session Runtime is unreachable, the dispatch layer falls back to direct CLI invocation with a logged warning. The fallback uses the same skill reference and context variables but skips containment and cost tracking. Removed when Phase 2 (ARCH-AC-SPEC-PIPELINE) replaces the script.

## Key Decisions

**Session type definitions: Static config, not database.** Four AgentDefinitions are defined in a TypeScript module alongside their containment rules. Chosen over config file or database because the set is fixed (four types), changes require code review, and TypeScript enforces the shape at compile time.

**Work type to session type mapping: Explicit switch.** A function maps `PipelineWorkType` union to a session type name. Chosen over a generic lookup table because the mapping includes validation (e.g., re-run sessions carry feedback content) and the four cases are exhaustive — TypeScript's `never` check catches missing cases.

**DispatchResult interpretation: Pattern match on status.** The orchestration script handles each `DispatchResult.status` variant explicitly. `completed` resets backoff. `failed` and `timed-out` increment backoff. `budget-exceeded` sleeps until reset. `rate-limited` sleeps for the cooldown duration. No default/catch-all — exhaustive matching ensures new statuses are handled at compile time.

**Budget pre-check: Query before dispatch.** Before constructing a DispatchRequest, the script queries Session Runtime for budget and rate limit state. This avoids constructing context and mapping session types when dispatch would immediately fail. Uses the same Session Runtime API (no separate endpoint).

**Fallback detection: Connection check with timeout.** The fallback triggers when Session Runtime's spawn API throws a connection error (ECONNREFUSED, ENOTFOUND, or timeout). Application-level errors (budget-exceeded, rate-limited) are NOT fallback triggers — they are normal DispatchResult statuses.

**Containment rules per session type: Path pattern arrays.** Each AgentDefinition includes `allowedWritePaths` (glob patterns) and `deniedWritePaths` (glob patterns). The Session Runtime applies these — the dispatch layer only declares them. Example: l2-designer allows `.specify/architecture/**` and `.specify/traceability.yml`, denies everything else.

## Examples

```typescript
// Pipeline work type to session type mapping
type PipelineWorkType = 'l2-brainstorm' | 'l3-generate' | 'compliance-review' | 'implementation';
type DispatchStatus = 'completed' | 'failed' | 'timed-out' | 'budget-exceeded' | 'rate-limited';
```

```typescript
// DispatchRequest — plain value object
interface DispatchRequest {
  sessionType: PipelineWorkType;
  context: { issueNumber: number; repo: string; feedback?: string };
  baseBranch: string; // always 'dev'
}
```

```typescript
// DispatchResult — structured return from Session Runtime
interface DispatchResult {
  status: DispatchStatus;
  costIncurred: number;
  durationMs: number;
  summary: string;
  cooldownMs?: number; // present when status is 'rate-limited'
}
```

```typescript
// Exhaustive status handling — no default case
function handleResult(result: DispatchResult, state: RunState): void {
  switch (result.status) {
    case 'completed': state.failCount = 0; break;
    case 'failed': case 'timed-out': state.failCount++; break;
    case 'budget-exceeded': state.sleepUntil = nextBudgetReset(); break;
    case 'rate-limited': state.sleepUntil = Date.now() + (result.cooldownMs ?? 0); break;
  }
}
```

```typescript
// Fallback: direct invocation when Session Runtime unreachable
async function dispatchWithFallback(req: DispatchRequest, runtime: SessionRuntime): Promise<DispatchResult> {
  try { return await runtime.spawn(req); }
  catch (err) { if (isConnectionError(err)) return directInvoke(req); throw err; }
}
```

## Gotchas

- The four session type names (`l2-designer`, `l3-generator`, `compliance-reviewer`, `spec-implementer`) must match the AgentDefinition names registered in Session Runtime (STACK-AC-SESSION-RUNTIME). A mismatch causes a runtime lookup failure with no compile-time warning — add a startup validation that checks all four exist.
- `DispatchRequest.context.feedback` is only populated for re-run sessions (issues with `l2-in-progress` or `l3-in-progress` labels from prior failed runs). Passing empty feedback on a first run is harmless but wastes prompt tokens — check before including.
- The fallback to direct invocation skips containment enforcement. This is acceptable during transition but means a misbehaving session could write outside its allowed paths. Log a prominent warning so the Operator knows containment is degraded.
- Budget pre-check and dispatch are not atomic. Between the check and the spawn call, another session could exhaust the budget. The Session Runtime handles this gracefully (returns `budget-exceeded`), so the pre-check is an optimization, not a guarantee.
- The `cooldownMs` field in DispatchResult is only meaningful when status is `rate-limited`. Do not read it for other statuses — it may be undefined or stale.
- When the Phase 2 FSM (ARCH-AC-SPEC-PIPELINE) is implemented, the fallback path and the orchestration script's dispatch call are both removed. The session type registry and AgentDefinitions survive — they evolve into native FSM session types.
