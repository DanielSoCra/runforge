---
id: STACK-AC-IMPLEMENTATION
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-IMPLEMENTATION
code_paths:
  - src/implementation/
test_paths:
  - src/implementation/**/*.test.ts
---

# STACK-AC-IMPLEMENTATION — Implementation Coordinator (TypeScript)

## Pattern

**Task graph as a serializable data structure.** The task graph is a plain JSON object stored in the run state. Units are objects with IDs, batch numbers, and dependency arrays. No graph library — the graph is simple enough (batched DAG with no cycles) that array operations suffice.

**Sequential batch execution with concurrent units.** Batches run sequentially. Within a batch, units run concurrently via `Promise.allSettled()` with a stagger delay between starts. `allSettled` (not `all`) ensures one unit failure doesn't cancel siblings.

**Git worktree for workspace isolation.** Each unit gets a git worktree branched from the feature branch. Worktrees share the `.git` directory (disk-efficient) but have independent working trees. After completion, the worktree diff is merged back to the feature branch.

## Key Decisions

**Workspace isolation: Git worktrees.** `git worktree add workspaces/{unit-id} -b unit/{unit-id} feature-branch`. Chosen over full clones (too slow, too much disk) and Docker-only isolation (worktrees handle the branch mechanics natively; Docker handles environment isolation at the Session Runtime layer). Worktrees and Docker compose: the Docker container runs a worktree.

**Merge strategy: Sequential merge with `--no-ff`.** After a batch completes, merge each unit's worktree into the feature branch sequentially. `--no-ff` creates a merge commit for traceability. If a merge conflict occurs, spawn a Conflict Resolver session (via Session Runtime) with both diffs and the governing spec content.

**Diff size measurement: `git diff --stat`.** After unit completion, measure `insertions + deletions` from `git diff --stat feature-branch...unit/{unit-id}`. If the total exceeds the configured threshold (default: 300 lines), reject the unit and re-decompose.

**Context assembly: Template literals.** Each unit's prompt is assembled by interpolating spec content, unit assignment, and pitfalls into a template string. Spec content order is reversed between coordinator (understanding: L1→L2→L3) and worker (implementation: L3→L2→L1) sessions. No template engine library — template literals with tagged functions suffice.

**Checkpoint persistence: RunState sub-phases.** The current batch number and completed unit IDs are saved as a checkpoint in the RunState after each batch. On crash recovery, skip completed batches and re-run incomplete ones.

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
// Git worktree creation
await git(['worktree', 'add', `workspaces/${unit.id}`,
           '-b', `unit/${unit.id}`, featureBranch]);
```

```typescript
// Sequential merge after batch
for (const unit of completedUnits) {
  const result = await git(['merge', '--no-ff', `unit/${unit.id}`,
                            '-m', `merge: ${unit.title}`], featureBranchDir);
  if (!result.ok) await resolveConflict(unit, result.error);
}
```

```typescript
// Diff size check
const stat = await git(['diff', '--stat', `${featureBranch}...unit/${unit.id}`]);
const lines = parseDiffStatTotal(stat.value); // insertions + deletions
if (lines > config.maxDiffLines) return { status: 'oversized', lines };
```

## Gotchas

- Git worktrees share the `.git` directory. Running `git gc` or `git prune` while worktrees are active can corrupt them. Never run maintenance commands while units are executing.
- Worktree cleanup: `git worktree remove workspaces/{unit-id}` must happen even on failure. Use a `finally` block. If the worktree is in a dirty state, `--force` is needed.
- `Promise.allSettled` returns `PromiseSettledResult[]` — check `.status === 'fulfilled'` or `'rejected'`. Do not use `.value` without checking status.
- Stagger delay must be long enough to avoid concurrent git operations on the same repo. Git's index lock (`index.lock`) serializes writes — concurrent worktree operations can fail with lock contention. The stagger delay should be at least 2-3 seconds.
- When merging sequential units, later merges see the accumulated result of earlier merges. This is correct behavior — it matches the batch dependency model (units in the same batch should not conflict; conflicts indicate a decomposition problem).
- Feature branch must be up to date with the staging branch before starting a new batch sequence. The Control Plane handles this rebase before calling Implement.
