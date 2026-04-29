---
id: STACK-AC-DAG-EXECUTOR
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DAG-EXECUTOR
code_paths:
  - packages/daemon/src/control-plane/dag-executor.ts
  - packages/daemon/src/control-plane/workflow-types.ts
  - packages/daemon/src/control-plane/workflow-registry.ts
  - packages/daemon/src/control-plane/builtin-workflows.ts
  - packages/daemon/src/control-plane/run-state-migration.ts
test_paths:
  - packages/daemon/src/control-plane/dag-executor.test.ts
  - packages/daemon/src/control-plane/workflow-types.test.ts
  - packages/daemon/src/control-plane/run-state-migration.test.ts
---

# STACK-AC-DAG-EXECUTOR — DAG-Based Workflow Executor (TypeScript)

## Pattern

**Discriminated union for WorkflowNode types.** A `kind` field narrows the union in exhaustive `switch` statements — the TypeScript compiler catches missing cases via `never`. Three kinds: `task`, `parallel`, `loop`. No base class, no interface hierarchy.

**Kahn's algorithm for topological validation.** A simple in-degree table resolves execution order and detects cycles in `O(V+E)`. Used only by the `Validate` API at registration time — runtime dispatch follows `nextNodeId` pointers directly without re-sorting.

**`Promise.all` with `AbortController` for parallel fan-out.** Each child in a `ParallelGroup` receives an `AbortSignal`. Under `fail-fast`, the first child failure fires `controller.abort()` — remaining children check the signal at their next `await` boundary and resolve early with a cancelled status.

**Async iterator for node dispatch.** The executor `yield`s a `NodeState` update after each node completes. The Control Plane `for await`s this generator, persisting state after each yield. This decouples persistence frequency from executor logic and enables crash-safe resume without a callback interface.

**Builtin variants as frozen TypeScript objects.** The four built-in `WorkflowDefinition` objects (`standard`, `simple`, `bug`, `adversarial-dev`) are plain object literals in `builtin-workflows.ts`, frozen with `Object.freeze`. No JSON/YAML loading at startup — type safety is free, startup cost is zero.

## Key Decisions

**No external DAG library.** Topological sort for the Validate API is ~20 lines of Kahn's algorithm. Runtime dispatch follows `nextNodeId` pointers directly — no sort needed. Chosen over `toposort`, `dag-map`, or `graphlib` to avoid a dependency for code that is simpler to write inline and easier to test.

**Zod for WorkflowDefinition schema.** Consistent with STACK-AC-CONVENTIONS. The same Zod schema validates operator-supplied YAML-parsed objects at startup and serves as the TypeScript type source via `z.infer`. One definition produces: runtime validation, TypeScript types, and readable error messages.

**`kind` discriminator over class hierarchy.** Exhaustive `switch (node.kind)` gives compile-time completeness checking with zero runtime overhead. A class hierarchy would require `instanceof` checks that are harder to test (need real instances) and introduce coupling between the executor and node constructors.

**Async generator for dispatch loop.** `yield` after each node state update lets the Control Plane persist incrementally. The alternative (callback on each update) would invert control and complicate testing. The generator is also pausable — the Control Plane can `break` out of the `for await` on graceful shutdown without cancelling in-flight children.

**RunState migration at load time, not write time.** Old-format `RunState` (with `currentPhase` / `phaseCompletionMap`) is converted to `nodeStates` once when loading from disk. Downstream code always sees the new format. Writing back in the new format is automatic — no dual-write path.

**AbortController for parallel cancellation.** A single `AbortController` per `ParallelGroup` execution. Under `fail-fast`, children check `signal.aborted` before each service call — they do not kill in-flight API requests, they skip the next dispatch step. This is sufficient because service calls are already bounded by timeouts in Session Runtime.

**Error hash normalization: reuse control-plane pattern.** The same `normalizeError` + `crypto.createHash('sha256')` approach from STACK-AC-CONTROL-PLANE applies at the `TaskNode` level. The hash is stored in `NodeState` (not just `RunState`) so parallel branches track errors independently.

## Examples

```typescript
// WorkflowDefinition — labelMap preserves FSM phase label observability
interface WorkflowDefinition {
  variant: string; entryNode: NodeId;
  nodes: Record<NodeId, WorkflowNode>; labelMap: Record<NodeId, string>;
}
```

```typescript
// WorkflowNode discriminated union — `kind` enables exhaustive switch checks
type WorkflowNode =
  | { kind: 'task'; phase: PhaseName; owner: ServiceOwner; maxRetries: number; next: NodeId; failNext?: NodeId }
  | { kind: 'parallel'; children: NodeId[]; policy: 'fail-fast' | 'continue-all'; next: NodeId; failNext?: NodeId }
  | { kind: 'loop'; innerEntry: NodeId; exitOn: 'success' | 'max-iterations'; maxIterations: number; next: NodeId; failNext?: NodeId };
```

```typescript
// Async generator — caller `for await`s; one yield per node enables crash-safe persist
async function* execute(def: WorkflowDefinition, state: RunState): AsyncGenerator<RunState> {
  for (let cur = def.entryNode; cur; cur = resolveNext(node, ns)) {
    const [node, ns] = [def.nodes[cur], await dispatchNode(def.nodes[cur], state, def)];
    yield { ...state, nodeStates: { ...state.nodeStates, [cur]: ns } };
  }
}
```

```typescript
// Parallel fan-out with AbortController (fail-fast)
async function runParallel(group: ParallelNode, children: WorkflowNode[], signal: AbortSignal) {
  const ctrl = new AbortController();
  const tasks = children.map(child => runChild(child, ctrl.signal));
  if (group.policy === 'fail-fast') tasks.forEach(t => t.catch(() => ctrl.abort()));
  return Promise.all(tasks);
}
```

```typescript
// Kahn's algorithm — cycle detection for Validate API
function topologicalSort(nodes: Record<NodeId, WorkflowNode>): NodeId[] | 'cycle' {
  const inDegree: Record<NodeId, number> = Object.fromEntries(Object.keys(nodes).map(id => [id, 0]));
  for (const node of Object.values(nodes)) successors(node).forEach(s => inDegree[s]++);
  // ... standard Kahn queue drain; returns 'cycle' if queue empties before all nodes visited
}
```

```typescript
// Old-format RunState migration — convert FSM fields to nodeStates
function migrateRunState(raw: unknown, def: WorkflowDefinition): RunState {
  if (!isLegacyRunState(raw)) return raw as RunState;
  const nodeStates = buildNodeStatesFromPhaseMap(raw.phaseCompletionMap, def);
  return { ...raw, nodeStates, currentNodeId: phaseToNodeId(raw.currentPhase, def) };
}
```

## Gotchas

- `Object.freeze` on builtin `WorkflowDefinition` objects is shallow. Nested `nodes` map entries are not frozen — mutating them at runtime would silently corrupt shared state. Freeze at the node level too, or use a defensive copy when the executor reads node properties.
- The async generator pauses at each `yield`. If the Control Plane does not call `.next()` (e.g., it `break`s early on shutdown), in-flight `Promise.all` children are not cancelled — they will resolve into a garbage-collected generator. This is safe but wastes API calls. The Control Plane should signal children via the `AbortController` before breaking the loop.
- `normalizeError` must strip timestamps, run IDs, file paths, and line numbers before hashing. Over-stripping (e.g., removing all numbers) will cause false positives — different errors hash to the same value. Under-stripping (e.g., keeping timestamps) will miss circular errors. Copy the exact regex patterns from `STACK-AC-CONTROL-PLANE` to ensure consistency.
- The `innerEntry` node in a `LoopNode` must be a node in the same `WorkflowDefinition`. The Validate API checks this — but operator-supplied definitions are validated at registration time, not at runtime. If a definition is patched after registration (e.g., a builtin is accidentally mutated), the check will not re-run. Freeze all node maps.
- Loop iteration resets inner `NodeState` entries per iteration. Do not reset the `LoopNode`'s own `NodeState` — the iteration counter lives there. The executor increments `nodeState.iterationCount` before each inner run.
- `phaseToNodeId` in the migration function requires a `WorkflowDefinition`. On crash recovery, the Control Plane must select the correct variant BEFORE calling `migrateRunState`. If the variant is unknown (removed operator definition), skip migration and enter stuck — do not guess the node ID.
- Under `continue-all`, all parallel children must complete before the group advances. A child that hangs indefinitely blocks the group. Session Runtime's per-session timeout is the backstop — confirm that all session types dispatched inside a `ParallelGroup` have explicit timeouts configured.
