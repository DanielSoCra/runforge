---
id: STACK-AC-COORDINATION
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-COORDINATION
code_paths:
  - packages/daemon/src/coordination/
  - packages/daemon/src/coordination/coordinator.ts
  - packages/daemon/src/coordination/concurrency.ts
  - packages/daemon/src/coordination/batch-manager.ts
  - packages/daemon/src/coordination/work-claimer.ts
  - packages/daemon/src/coordination/po-agent.ts
  - packages/daemon/src/coordination/terminal-server.ts
  - packages/daemon/src/coordination/types.ts
test_paths:
  - packages/daemon/src/coordination/**/*.test.ts
---

# STACK-AC-COORDINATION — Coordination Service (TypeScript)

## Pattern

**Coordinator as tick-driven loop.** The Coordinator runs a `setInterval` tick (configurable period, default 5 seconds). Each tick evaluates the concurrency algorithm: enforce per-type minimums, fill from immediate dispatch queue, fill from active Batch ready set. The tick is the heartbeat — all dispatch decisions happen here, never ad-hoc.

**Data model as Zod schemas with inferred types.** All coordination entities (Proposal, Batch, BatchItem, WorkerClaim, MergeQueueEntry, IdeaSubmission) are defined as Zod schemas. TypeScript types are derived via `z.infer`. Runtime validation on read, type safety on write. Persisted as JSON files via atomic write (STACK-AC-CONVENTIONS).

**Batch state machine as explicit transition table.** Same pattern as the Control Plane FSM (STACK-AC-CONTROL-PLANE): a `Record<BatchStatus, Record<BatchEvent, { next, action }>>` with exhaustive matching. States: `planning`, `active`, `completed`, `cancelled`. No state machine library.

**Work claiming with atomic file operations.** Claims are exclusive via a partial uniqueness check: before creating a claim, scan existing claims for the same issue number with an active status. The scan-and-write is serialized through the Coordinator's tick (single-process, single tick at a time) — no database lock needed. Labels are applied after the claim file is written.

**Terminal interface via MCP server.** The Coordination Service exposes its API through a Model Context Protocol (MCP) server running over stdio transport, invoked from any terminal via `claude mcp`. Operations map to MCP tools: `list_proposals`, `submit_idea`, `approve_proposal`, `reject_proposal`, `get_briefing`, `get_active_work`, `get_batch_plan`, `pause_daemon`, `resume_daemon`, `cancel_batch`, `reprioritize_issue`.

**PO agent as scheduled session.** The PO runs on a configurable interval via `setInterval`. Each cycle: read codebase signals, produce Proposals, sweep expired Proposals. Idea submissions trigger a debounced evaluation (at most once per interval). The PO session is spawned via Session Runtime with a dedicated agent definition.

## Key Decisions

**Persistence: JSON files, not database.** Coordination state lives in `state/coordination/` as JSON files (one per entity type or per entity). Follows the project's existing persistence pattern (STACK-AC-CONVENTIONS). Atomic writes prevent corruption. The single-process model eliminates concurrency concerns. Chosen over SQLite (adds a dependency the project avoids) and in-memory only (not crash-safe).

**File layout for coordination state:**
- `state/coordination/proposals.json` — array of Proposals
- `state/coordination/batches.json` — array of Batches with embedded BatchItems
- `state/coordination/claims/` — one file per active WorkerClaim (`{issue}-{attempt}.json`)
- `state/coordination/merge-queue.json` — array of MergeQueueEntries
- `state/coordination/ideas.json` — array of IdeaSubmissions

**Concurrency algorithm: Priority-ordered fill.** On each tick: (1) count active claims by agent type, (2) spawn to meet per-type minimums, (3) fill remaining slots from immediate dispatch queue (FIFO), (4) fill remaining slots from active Batch ready set (dependency order). Per-type maximums cap each type. Per-repo limits checked before each spawn. Disk space guard checked before any spawn.

**Worker isolation: Git worktrees.** Each worker gets an isolated git worktree created from the integration branch (`dev`). Worktrees are created via `git worktree add` in a configurable directory (default `state/worktrees/`). On completion or failure, `git worktree remove` cleans up. A periodic GC pass (configurable interval, default 10 minutes) removes orphaned worktrees with no active WorkerClaim.

**Batch dependency graph: Adjacency list.** BatchItems store dependency edges as an array of BatchItem IDs. The "ready set" is computed by filtering items whose dependencies all have terminal-satisfied status (`completed` or `skipped`). No topological sort library — the ready set computation is a simple filter on each tick.

**Terminal server: `@modelcontextprotocol/sdk`.** Uses the official MCP TypeScript SDK with stdio transport. Each operation is registered as an MCP tool with a Zod input schema. The server runs as a child of the daemon process. Chosen over a custom HTTP API (the project already has an HTTP control API in the Control Plane — the terminal interface is conversational and benefits from MCP's tool-calling model).

**Proposal expiry: Sweep on PO cycle.** The PO agent's scheduled cycle includes a sweep that transitions `proposed` Proposals past their expiry timestamp to `expired`. No separate timer — piggybacks on the existing PO schedule.

**GlobalSettings extension: Config file.** New coordination settings (`max_agents`, `reviewer_interval`, `po_interval`, `planner_timeout`, `max_attempts_per_issue`, `disk_space_threshold`, `gc_interval`) are added to the existing config schema (STACK-AC-CONVENTIONS `config.ts`). Validated via Zod on startup.

## Examples

```typescript
// Coordination entity schemas (Zod)
const ProposalSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  rationale: z.string(),
  scope: z.enum(['small', 'medium', 'large']),
  status: z.enum(['proposed', 'approved', 'rejected', 'expired']),
  issueNumber: z.number().nullable(),
  expiresAt: z.string().datetime(),
});
type Proposal = z.infer<typeof ProposalSchema>;
```

```typescript
// Batch state machine — exhaustive transition table
type BatchStatus = 'planning' | 'active' | 'completed' | 'cancelled';
type BatchEvent = 'finalize' | 'all_merged' | 'cancel';
const batchTransitions: Record<BatchStatus, Partial<Record<BatchEvent, BatchStatus>>> = {
  planning: { finalize: 'active' },
  active: { all_merged: 'completed', cancel: 'cancelled' },
  completed: {},
  cancelled: {},
};
```

```typescript
// Concurrency algorithm — tick handler (enforce mins, fill queue, fill batch)
function evaluatePool(claims: WorkerClaim[], config: CoordinationConfig): SpawnDecision[] {
  const active = claims.filter(c => isActiveStatus(c.status));
  if (active.length >= config.maxAgents) return [];
  return [...enforceMinimums(active, config), ...fillFromQueue(active, config)];
}
```

```typescript
// Work claiming — atomic file write with uniqueness check
async function claimIssue(issueNumber: number, agentType: AgentType): Promise<Result<WorkerClaim>> {
  if (await findActiveClaim(issueNumber)) return { ok: false, error: new Error('already claimed') };
  const claim = { id: randomUUID(), issueNumber, attempt: 1, agentType, status: 'claimed' as const };
  await writeJsonSafe(`state/coordination/claims/${issueNumber}-${claim.attempt}.json`, claim);
  return { ok: true, value: claim };
}
```

```typescript
// MCP terminal server — tool registration
server.tool('list_proposals', { statusFilter: z.enum([...]).optional() }, async (params) => {
  const proposals = await loadProposals();
  const filtered = params.statusFilter ? proposals.filter(p => p.status === params.statusFilter) : proposals;
  return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
});
```

## Gotchas

- The Coordinator tick and PO/Planner session spawns share the event loop. A long-running tick blocks PO evaluation. Keep tick logic synchronous and fast — defer heavy work (session spawning, git operations) to async continuations after the tick completes.
- Git worktree creation requires the base branch to exist locally. If `dev` is not fetched, `git worktree add` fails. Always `git fetch origin dev` before creating a worktree.
- The MCP stdio transport requires the daemon to manage the server process lifecycle. If the terminal disconnects, the server process must be cleaned up. Use `process.on('disconnect')` or stdin close detection.
- Proposal expiry sweep runs on the PO schedule. If the PO interval is long (e.g., 1 hour), proposals may linger past their expiry. This is acceptable — expiry is advisory, not a hard guarantee.
- WorkerClaim files use `{issue}-{attempt}.json` naming. On retry, attempt increments. Old claim files (failed attempts) are kept for audit but excluded from active claim queries by status check.
- Per-repo concurrency limits come from existing repository configuration (STACK-AC-CONTROL-PLANE). The Coordinator must read this config — it is not duplicated in coordination config.
- The `max_agents` cap includes all pooled agent types (PO, Planner, Worker, Reviewer) but excludes the Merge Agent, which runs outside the pool. The Merge Agent is supervised directly by the Coordinator (restart on unexpected exit unless paused/shutting down).
- Disk space check uses `fs.statfs()` (Node 22+). On macOS, `f_bavail * f_bsize` gives available bytes. Compare against `disk_space_threshold` config. If below threshold, skip all spawns and post a warning to the briefing page.
