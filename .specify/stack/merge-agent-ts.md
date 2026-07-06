---
id: STACK-AC-MERGE-AGENT
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-COORDINATION
code_paths:
  - packages/daemon/src/coordination/merge-agent.ts
  - packages/daemon/src/coordination/conflict-resolver.ts
  - packages/daemon/src/coordination/merge-queue.ts
test_paths:
  - packages/daemon/src/coordination/merge-agent.test.ts
  - packages/daemon/src/coordination/conflict-resolver.test.ts
  - packages/daemon/src/coordination/merge-queue.test.ts
---

# STACK-AC-MERGE-AGENT — Merge Queue Agent (TypeScript)

## Pattern

**Queue consumer with single-active-entry lock.** The Merge Agent polls `merge-queue.json` for `queued` entries, selects the highest-priority entry whose dependencies are satisfied, and processes it through a phase pipeline: `queued` → `rebasing` → `merging` → `validating` → (success: `merged`, failure: `reverted`). Only one entry can be in an active phase (`rebasing`, `merging`, `validating`) at a time — enforced by checking the queue file before advancing.

**Phase-tracked operations for crash recovery.** Each phase transition is persisted to disk before the operation begins. On restart, the Merge Agent reads entries with non-terminal phases and recovers deterministically: check observable outcomes (does the merge commit exist on the integration branch?) to decide whether to advance or retry.

**Conflict resolution via LLM session with size guard.** When `git merge --no-ff` produces conflicts, the Merge Agent checks conflict size against configurable thresholds (files and lines). Small conflicts spawn a conflict resolution session via Session Runtime with the conflicting files and spec context. Large conflicts or resolution failures mark the entry `needs_human`.

## Key Decisions

**Queue priority: Batch dependency order, then FIFO.** Entries within a Batch merge in the order defined by the Batch's dependency graph (lower priority value first). Entries outside a Batch (immediate dispatch) merge in FIFO order by creation timestamp. The selection algorithm: filter `queued` entries with satisfied dependencies, sort by priority then creation time, take the first.

**Merge strategy: No-fast-forward, single atomic commit.** `git merge --no-ff` creates a merge commit even when fast-forward is possible. This preserves branch history for auditability. The merge is a single operation — if it fails, the working state is clean (no partial merge).

**Conflict size measurement: `git diff --stat` parsing.** After a failed merge, parse `git diff --stat` output to count conflicting files and `grep -c '<<<<<<<'` on each conflicting file to count conflict lines. Compare against `conflict_file_threshold` (default 3) and `conflict_line_threshold` (default 100).

**Conflict resolution session: Scoped context.** The resolution session receives: the conflicting file contents (both sides), the spec context (L3 spec governing the conflicting files from traceability.yml), and the PR description. Budget-capped per session. Spawned via Session Runtime with a dedicated `conflict-resolver` agent definition. The session outputs resolved file contents; the Merge Agent applies them and commits.

**Post-merge validation: Delegate to Validation Service.** After a successful merge, the Merge Agent invokes the Validation Service (STACK-AC-VALIDATION) to run the affected spec's `test_paths`. A configurable timeout (default 10 minutes) guards against hung validation. On timeout: release the merge lock, mark `failed`.

**Revert strategy: Single revert commit.** On validation failure, `git revert --no-edit <merge-commit>` creates a clean revert. The integration branch is never left in a broken state. The MergeQueueEntry phase transitions to `reverted`, status to `failed`.

**Dependency timeout: Configurable with operator notification.** If an entry's dependency has not been fulfilled within `merge_dependency_timeout` (default 30 minutes), the entry is marked `blocked`. The briefing page surfaces blocked entries under "Needs Attention."

**Merge Agent lifecycle: Supervised by Coordinator.** The Merge Agent runs as an async loop within the daemon process (not a separate process). The Coordinator starts the loop on daemon startup and restarts it on unexpected errors (unless paused or shutting down). The loop uses a configurable poll interval (default 5 seconds) with exponential backoff on consecutive errors.

## Examples

```typescript
// Merge queue entry selection — priority then FIFO
function selectNext(queue: MergeQueueEntry[]): MergeQueueEntry | null {
  return queue
    .filter(e => e.status === 'queued' && dependenciesSatisfied(e, queue))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
    [0] ?? null;
}
```

```typescript
// Phase-tracked merge — persist phase before each git operation
async function processMerge(entry: MergeQueueEntry): Promise<Result<string>> {
  await updatePhase(entry, 'rebasing');
  const rebase = await git(['rebase', 'dev', entry.headRef]);
  if (!rebase.ok) return rebase;
  await updatePhase(entry, 'merging');
  return (await git(['merge', '--no-ff', entry.headRef])).ok ? rebase : handleConflict(entry);
}
```

```typescript
// Conflict size check against thresholds
async function isSmallConflict(cwd: string, config: MergeConfig): Promise<boolean> {
  const files = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!files.ok) return false;
  const fileCount = files.value.split('\n').filter(Boolean).length;
  return fileCount <= config.conflictFileThreshold;
}
```

```typescript
// Crash recovery — check observable outcome per phase
async function recoverEntry(entry: MergeQueueEntry): Promise<void> {
  if (entry.mergePhase === 'merging') {
    const exists = await mergeCommitExists(entry.headRef);
    if (exists) { await updatePhase(entry, 'validating'); }
    else { await updateStatus(entry, 'queued'); } // retry
  }
}
```

```typescript
// Validation timeout guard
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), config.validationTimeoutMs);
try {
  await validationService.run(entry.issueNumber, { signal: controller.signal });
} finally { clearTimeout(timeout); }
```

## Gotchas

- `git merge --no-ff` requires the integration branch to be checked out. The Merge Agent must operate on a dedicated worktree for the integration branch, separate from worker worktrees. Create this worktree once on startup (`state/merge-worktree/`).
- `git revert` can itself produce conflicts if subsequent commits depend on the reverted merge. In this case, the revert fails and the entry must be marked `needs_human` — automatic revert is best-effort.
- The conflict resolution session must run in the merge worktree (not a fresh worktree) because the conflict markers are in the working tree after the failed merge. Pass the merge worktree path as the session workspace.
- Polling interval backoff: on consecutive errors, double the interval up to a configurable maximum (default 60 seconds). Reset to base interval on any successful operation. This prevents tight error loops when the integration branch is in a bad state.
- The Merge Agent runs outside the agent pool (`max_agents` cap). It does not consume a pool slot. The Coordinator tracks it separately and restarts it on failure.
- Branch cleanup after successful merge: delete the task branch both locally (`git branch -d`) and remotely (`git push origin --delete`). If remote delete fails (e.g., branch protection), log a warning and continue — it is not critical.
- The `merge_phase` and `status` fields serve different purposes. `merge_phase` tracks the current operational step (what the agent is doing now). `status` tracks the cumulative outcome (what happened overall). Do not conflate them in status queries.
