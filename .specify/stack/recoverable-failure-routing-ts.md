---
id: STACK-AC-RECOVERABLE-FAILURE-ROUTING
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-RECOVERABLE-FAILURE-ROUTING
code_paths:
  - packages/daemon/src/types.ts
  - packages/daemon/src/control-plane/pipeline.ts
  - packages/daemon/src/control-plane/fsm.ts
  - packages/daemon/src/control-plane/phases.ts
  - packages/daemon/src/control-plane/workspace.ts
  - packages/daemon/src/control-plane/work-detection.ts
  - packages/daemon/src/control-plane/daemon.ts
test_paths:
  - packages/daemon/src/control-plane/pipeline.test.ts
  - packages/daemon/src/control-plane/phases.test.ts
  - packages/daemon/src/control-plane/workspace.test.ts
  - packages/daemon/src/control-plane/work-detection.test.ts
  - packages/daemon/src/control-plane/daemon.test.ts
---

# STACK-AC-RECOVERABLE-FAILURE-ROUTING - Recoverable Failure Routing (TypeScript)

## Pattern

**FailureRecord discriminated union.** Add a `PipelineFailureKind` union and `FailureRecord` interface in shared types. Keep `PhaseEvent` small, but let handlers attach `run.lastFailure` before returning a failure event.

**Failure router before stuck transition.** `runPipeline()` classifies and routes failures before `advancePhase()` can exhaust retries into `stuck`.

**Repair queue as JSON state.** Persist queue items under control-plane state using the existing safe JSON store helpers. Repair state must survive daemon restarts.

**Status publication adapter.** Centralize label/comment publication for repairable and human-required states so work detection does not need to infer meaning from raw failures.

## Key Decisions

**Do not overload `PhaseEvent`.** Keep existing phase transition strings for compatibility. Store typed metadata on RunState and PipelineResult, where consumers can migrate incrementally.

**Start with workspace and delivery repair.** These are the #489 failure families that caused permanent stuck states. Other kinds may initially route to human-required until implementation-specific repair actions exist.

**Use existing backoff settings.** Reuse retry backoff base and maximum values for repair scheduling. Add per-kind attempt caps only when default phase attempts are insufficient.

**Publish `needs-repair` before `stuck`.** Repairable failures should remove active phase labels and apply a repair-visible label. Only repair exhaustion applies the existing terminal stuck path.

## Examples

```typescript
type PipelineFailureKind =
  | 'workspace-repair-needed'
  | 'delivery-repair-needed'
  | 'agent-output-invalid'
  | 'human-required';
```

```typescript
interface FailureRecord {
  kind: PipelineFailureKind;
  phase: Phase;
  retryable: boolean;
  repairAction: 'recreate-workspace' | 'reconcile-artifact' | 'retry-session' | 'request-human';
}
```

```typescript
if (run.lastFailure?.retryable) {
  await repairQueue.enqueue(run.id, run.lastFailure);
  return { outcome: 'repairing', run };
}
```

```typescript
run.lastFailure = {
  kind: 'workspace-repair-needed',
  phase: 'detect',
  retryable: true,
  repairAction: 'recreate-workspace',
};
```

## Gotchas

- `runWriter` outcome mapping currently expects complete, stuck, paused, failed, or parked style outcomes. Add database mapping before returning a new public outcome.
- Do not remove `stuck` immediately. Existing dashboard columns and work detection filters depend on it. Introduce repair states first, then migrate UI.
- Failure hashes should include kind and normalized message. Hashing only the message can merge unrelated failure families.
- Repair actions must be idempotent. A daemon restart may rerun the same queued repair item.
- A confirmed containment breach must bypass repair routing even if the session also reports a retryable provider signal.
