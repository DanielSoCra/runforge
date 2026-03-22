---
id: STACK-AC-IMPLEMENTATION
type: stack-specific
domain: auto-claude
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-IMPLEMENTATION
code_paths:
  - packages/daemon/src/implementation/
  - packages/daemon/src/implementation/coordinator.ts
  - packages/daemon/src/implementation/decompose.ts
  - packages/daemon/src/implementation/batch.ts
  - packages/daemon/src/implementation/merge.ts
  - packages/daemon/src/implementation/fix.ts
  - packages/daemon/src/implementation/context.ts
  - packages/daemon/src/implementation/exit-status.ts
test_paths:
  - packages/daemon/src/implementation/**/*.test.ts
---

# STACK-AC-IMPLEMENTATION — Implementation Coordinator (TypeScript)

## Pattern

**Task graph as a serializable data structure.** The task graph is a plain JSON object stored in the run state. Units are objects with IDs, batch numbers, and dependency arrays. No graph library — the graph is simple enough (batched DAG with no cycles) that array operations suffice.

**Sequential batch execution with concurrent units.** Batches run sequentially. Within a batch, units run concurrently via `Promise.allSettled()` with a stagger delay between starts. `allSettled` (not `all`) ensures one unit failure doesn't cancel siblings.

**Git worktree for workspace isolation.** Each unit gets a git worktree branched from the feature branch. Worktrees share the `.git` directory (disk-efficient) but have independent working trees. After completion, the worktree diff is merged back to the feature branch.

**Decomposition via one-shot coordinator session.** The Decompose operation assembles all inputs (work request, spec content in understanding order L1→L2→L3, traceability map) into a single prompt, spawns a one-shot session via Session Runtime with structured output, and validates the result against a Zod schema. On validation failure, retry once before escalating.

**Exit status routing as a discriminated union.** Each unit reports one of four exit statuses: `completed`, `completed-with-concerns`, `blocked`, `needs-context`. A switch on the status field drives the follow-up path — merge, flag-for-review, escalate, or re-run with parent-layer context.

**Fix operation as a single-unit implementation.** When the Validation Service reports findings, the Fix operation creates a single-unit workspace, assembles context with findings and governing specs, and spawns a worker session using a regression-test-first protocol.

## Key Decisions

**Workspace isolation: Git worktrees.** `git worktree add workspaces/{unit-id} -b unit/{unit-id} feature-branch`. Chosen over full clones (too slow, too much disk) and Docker-only isolation (worktrees handle the branch mechanics natively; Docker handles environment isolation at the Session Runtime layer). Worktrees and Docker compose: the Docker container runs a worktree.

**Merge strategy: Sequential merge with `--no-ff`.** After a batch completes, merge each unit's worktree into the feature branch sequentially. `--no-ff` creates a merge commit for traceability. If a merge conflict occurs, spawn a Conflict Resolver session (via Session Runtime) with both diffs and the governing spec content.

**Diff size measurement: `git diff --stat`.** After unit completion, measure `insertions + deletions` from `git diff --stat feature-branch...unit/{unit-id}`. If the total exceeds the configured threshold (default: 300 lines), reject the unit and re-decompose into smaller sub-units in a subsequent batch.

**Context assembly: Template literals with role-based ordering.** Each unit's prompt is assembled by interpolating spec content, unit assignment, and pitfalls into a template string. Spec content order is reversed between coordinator (understanding: L1→L2→L3) and worker (implementation: L3→L2→L1) sessions. No template engine library — template literals with tagged functions suffice.

**Checkpoint persistence: RunState sub-phases.** The current batch number and completed unit IDs are saved as a checkpoint in the RunState after each batch. On crash recovery, skip completed batches and re-run incomplete ones.

**Task graph validation: Zod schema.** The decomposition session returns structured JSON validated against a Zod schema: unique unit IDs, sequential batch numbers, valid dependency references, no intra-batch or forward-batch dependencies. On schema failure, retry once before escalating to `stuck`.

**Conflict resolution: Dedicated resolver session.** On merge conflict, assemble the conflicting diff, governing specs for both units, and the spec intent. Spawn a Conflict Resolver session via Session Runtime. The resolver produces a merged result favoring spec intent. If the resolver times out or produces invalid output, mark the batch as failed and retry.

**Simple work requests: Skip decomposition.** When the Control Plane indicates a work request is classified as simple, create a single-unit task graph with one batch containing one unit. Proceed with the standard implementation flow — no coordinator session needed.

**Knowledge Service integration: Pitfall injection.** Before assembling each unit's context, query the Knowledge Service for pitfalls matching the unit's expected artifact locations. Pitfalls are injected into the worker prompt as a dedicated section. Workers never query the Knowledge Service directly.

**Context capacity: Recursive decomposition.** During decomposition validation, estimate each unit's total context size (spec content + expected artifacts + surrounding context). If a unit exceeds a configurable threshold, recursively decompose it into sub-units until each fits within one reasoning context.

**Worker prompt template: TDD protocol enforcement.** The worker prompt template enforces test-driven execution: write a failing verification → confirm it fails → implement → confirm verification passes → refactor → run local checks (lint, format, type-check) → fix issues → commit. This protocol is embedded in the template, not left to the worker's discretion.

**Post-integration verification: Shell command after batch merge.** After all units in a batch are merged into the feature branch, run a configurable verification command (e.g., `vitest run`) on the integrated branch. If verification fails, retry the entire batch (up to max retries). This catches integration issues that unit-level verification misses.

**Spec divergence: Reconciliation, not error.** When a worker encounters existing code that diverges from the governing spec, it treats the divergence as a reconciliation task — aligning the implementation to match the spec. The worker prompt template includes instructions to check for existing implementations before creating new ones.

**Retry budget: Per-unit attempts.** Each unit has a configurable max retry count (default: 2). `needs-context` re-runs consume a retry. `blocked` does not consume a retry — it escalates immediately. If retries exhaust, the unit transitions to `failed` and the batch is retried or escalated.

## Examples

```typescript
// Concurrent batch execution with stagger
async function executeBatch(units: Unit[], staggerMs: number) {
  const promises = units.map((unit, i) =>
    delay(i * staggerMs).then(() => executeUnit(unit))
  );
  return Promise.allSettled(promises);
}
```

```typescript
// Git worktree creation and cleanup
await git(['worktree', 'add', `workspaces/${unit.id}`,
           '-b', `unit/${unit.id}`, featureBranch]);
try { await runWorker(unit); }
finally { await git(['worktree', 'remove', `workspaces/${unit.id}`, '--force']); }
```

```typescript
// Exit status routing — discriminated union switch
switch (result.status) {
  case 'completed': mergeQueue.push(unit); break;
  case 'completed-with-concerns': mergeQueue.push(unit); run.flags.push('extra-review'); break;
  case 'blocked': await escalate(unit, result.reason); break;
  case 'needs-context': await retryWithParentSpec(unit); break;
}
```

```typescript
// Task graph validation via Zod
const TaskGraphSchema = z.object({
  issueNumber: z.number(),
  featureBranch: z.string(),
  units: z.array(UnitSchema).refine(units =>
    units.every(u => u.deps.every(d => units.some(t => t.id === d && t.batch < u.batch)))
  ),
});
```

```typescript
// Fix operation — single-unit workspace with regression-test-first
async function fix(findings: Finding[], specs: string[], branch: string) {
  const unit = { id: `fix-${Date.now()}`, specs, context: assembleFixContext(findings, specs) };
  await git(['worktree', 'add', `workspaces/${unit.id}`, '-b', unit.id, branch]);
  try { await spawnWorkerSession(unit, { protocol: 'regression-test-first' }); }
  finally { await git(['worktree', 'remove', `workspaces/${unit.id}`, '--force']); }
}
```

## Gotchas

- Git worktrees share the `.git` directory. Running `git gc` or `git prune` while worktrees are active can corrupt them. Never run maintenance commands while units are executing.
- Worktree cleanup: `git worktree remove workspaces/{unit-id}` must happen even on failure. Use a `finally` block. If the worktree is in a dirty state, `--force` is needed.
- `Promise.allSettled` returns `PromiseSettledResult[]` — check `.status === 'fulfilled'` or `'rejected'`. Do not use `.value` without checking status.
- Stagger delay must be long enough to avoid concurrent git operations on the same repo. Git's index lock (`index.lock`) serializes writes — concurrent worktree operations can fail with lock contention. The stagger delay should be at least 2-3 seconds.
- When merging sequential units, later merges see the accumulated result of earlier merges. This is correct behavior — it matches the batch dependency model (units in the same batch should not conflict; conflicts indicate a decomposition problem).
- Feature branch must be up to date with the staging branch before starting a new batch sequence. The Control Plane handles this rebase before calling Implement.
- Decomposition retry: the second attempt uses a fresh session, not the same one. The retry sends the same prompt — the structured output validation failure may be non-deterministic.
- `needs-context` re-runs inject the parent-layer spec content (L2 if worker had L3, L1 if worker had L2+L3). If the re-run still fails, the unit may need further decomposition — escalate as `stuck` rather than retrying indefinitely.
- Conflict Resolver sessions receive the raw diff output and both units' spec content. The resolver must choose a resolution consistent with spec intent, not just syntactic merge. If the resolver cannot decide, it should report `blocked` rather than guessing.
- The fix operation's regression-test-first protocol means: first write a test that reproduces the finding, confirm it fails, then fix the code, confirm the test passes. This ensures the fix actually addresses the finding and prevents regression.
- Oversized units (>300 lines changed) are not merged — they are split into sub-units and re-executed. The original unit's worktree is discarded. The sub-units start fresh from the feature branch at its current state.
- Worker timeout: Session Runtime terminates the worker after the configured timeout. The unit is marked `failed` and retried up to max attempts. The worktree is cleaned up in the `finally` block regardless.
- Post-integration verification runs on the merged feature branch, not on individual worktrees. A failure here means units that passed individually conflict when combined — retry the batch, not individual units.
