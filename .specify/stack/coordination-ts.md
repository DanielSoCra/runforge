---
id: STACK-AC-COORDINATION
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-COORDINATION
code_paths:
  - packages/daemon/src/coordination/
  - packages/daemon/src/coordination/coordinator.ts
  - packages/daemon/src/coordination/concurrency.ts
  - packages/daemon/src/coordination/batch-manager.ts
  - packages/daemon/src/coordination/work-claimer.ts
  - packages/daemon/src/coordination/inference-decision.ts
  - packages/daemon/src/coordination/protocol-orchestrator.ts
  - packages/daemon/src/coordination/terminal-server.ts
  - packages/daemon/src/coordination/types.ts
test_paths:
  - packages/daemon/src/coordination/**/*.test.ts
---

# STACK-AC-COORDINATION — Coordination Service (TypeScript)

## Pattern

**Coordinator as tick-driven loop.** The Coordinator runs a `setInterval` tick (configurable period, default 5 seconds). Each tick evaluates the concurrency algorithm: enforce per-type minimums, fill from immediate dispatch queue, fill from active Batch ready set. The tick also processes pending inference decisions (see below). The tick is the heartbeat — all dispatch and decision logic happens here, never ad-hoc.

**Data model as Zod schemas with inferred types.** All coordination entities (Batch, BatchItem, WorkerClaim, MergeQueueEntry, InferenceContext, InferenceDecision) are defined as Zod schemas. TypeScript types are derived via `z.infer`. Runtime validation on read, type safety on write. Persisted as JSON files via atomic write (STACK-AC-CONVENTIONS). Proposal and IdeaSubmission schemas are owned by the Product Ownership service — the Coordinator consumes but does not define them. The Run model (STACK-AC-CONTROL-PLANE) gains a `workerClaimId` field linking each run to the WorkerClaim that produced it.

**Batch state machine as explicit transition table.** Same pattern as the Control Plane FSM (STACK-AC-CONTROL-PLANE): a `Record<BatchStatus, Record<BatchEvent, { next, action }>>` with exhaustive matching. States: `planning`, `active`, `completed`, `cancelled`. No state machine library.

**Work claiming with atomic file operations.** Claims are exclusive via a partial uniqueness check: before creating a claim, scan existing claims for the same issue number with an active status (`claimed`, `in_progress`, `paused`, `pr_opened`). The scan-and-write is serialized through the Coordinator's tick (single-process, single tick at a time) — no database lock needed. Labels are applied after the claim file is written.

**Terminal interface via MCP server.** The Coordination Service exposes its API through a Model Context Protocol (MCP) server running over stdio transport, invoked from any terminal via `claude mcp`. Operations map to MCP tools: `get_briefing`, `get_active_work`, `get_batch_plan`, `pause_daemon`, `resume_daemon`, `cancel_batch`, `reprioritize_issue`. Proposal and idea operations (`list_proposals`, `submit_idea`, `approve_proposal`, `reject_proposal`) are routed through to the Product Ownership service. All MCP tools return structured errors: `{ code: 'not_found' | 'invalid_state' | 'unauthorized' | 'validation_error', message: string, operation: string }`.

**Inference-augmented decision points.** At specific junctures where deterministic rules are insufficient, the Coordinator assembles a narrow InferenceContext and submits it to Session Runtime for a lightweight single-turn inference call via `SessionRuntime.infer(prompt, schema)`. The call returns an InferenceDecision with a chosen action, confidence score, and rationale. If confidence meets the threshold, the Coordinator acts on it. If not, the decision is escalated to the operator. Decision points are processed within the tick — at most one inference call per decision point per tick, bounded by a per-tick inference budget.

**Protocol orchestration as in-process async calls.** The Coordinator triggers PO/TL protocols (Batch Planning, Escalation, Status Sync, Retrospective) by calling async methods on injected service interfaces (not HTTP — PO and TL services run in the same daemon process). The Coordinator sequences the protocol — it does not execute PO or TL behavior. Each protocol call is wrapped in `Promise.race` with a configurable timeout (default 60 seconds); on timeout, the Coordinator dispatches from the existing batch queue.

## Key Decisions

**Persistence: JSON files, not database.** Coordination state lives in `state/coordination/` as JSON files (one per entity type or per entity). Follows the project's existing persistence pattern (STACK-AC-CONVENTIONS). Atomic writes prevent corruption. The single-process model eliminates concurrency concerns. Chosen over SQLite (adds a dependency the project avoids) and in-memory only (not crash-safe). L1/L2 use "database" generically — this project maps that to file-based persistence, which is an intentional simplification given the single-process model.

**File layout for coordination state:**
- `state/coordination/batches.json` — array of Batches with embedded BatchItems
- `state/coordination/claims/` — one file per active WorkerClaim (`{issue}-{attempt}.json`)
- `state/coordination/merge-queue.json` — array of MergeQueueEntries (MergeQueueEntry schema and merge_phase/status duality are defined in STACK-AC-MERGE-AGENT)
- `state/coordination/inference-log.json` — bounded ring buffer of recent InferenceDecisions (default last 100, for operator visibility and debugging)

**PO/TL state is not owned here.** Proposals, ideas, and PO/TL session state are owned by their respective services. The Coordinator reads PO outputs (prioritized work items, priority decisions) and TL outputs (dependency graphs, effort estimates, health reports) but does not persist or manage them.

**Concurrency algorithm: Priority-ordered fill.** On each tick: (1) count active claims by agent type, (2) spawn to meet per-type minimums, (3) fill remaining slots from immediate dispatch queue (FIFO), (4) fill remaining slots from active Batch ready set (dependency order). Per-type maximums cap each type. Per-repo limits checked before each spawn. Disk space guard checked before any spawn.

**Worker isolation: Git worktrees.** Each worker gets an isolated git worktree created from the integration branch (`dev`). Worktrees are created via `git worktree add` in a configurable directory (default `state/worktrees/`). On completion or failure, `git worktree remove` cleans up. A periodic GC pass (configurable interval, default 10 minutes) removes orphaned worktrees with no active WorkerClaim.

**Batch dependency graph: Adjacency list.** BatchItems store dependency edges as an array of BatchItem IDs. The "ready set" is computed by filtering items whose dependencies all have terminal-satisfied status (`completed` or `skipped`). When a dependency reaches `failed`, the Coordinator invokes an inference decision point (`retry_skip_replan`) instead of applying a fixed rule. No topological sort library — the ready set computation is a simple filter on each tick.

**Terminal server: `@modelcontextprotocol/sdk`.** Uses the official MCP TypeScript SDK with stdio transport. Each operation is registered as an MCP tool with a Zod input schema. The server runs as a child of the daemon process. Proposal/idea tools delegate to the PO service. Chosen over HTTP (the project already has an HTTP control API in the Control Plane — the terminal interface is conversational and benefits from MCP's tool-calling model).

**Inference call: Single-turn via Session Runtime.** Inference decisions call `SessionRuntime.infer(prompt: string, schema: ZodSchema): Promise<T>` — a lightweight single-turn interface that sends one prompt with a structured output schema and returns the parsed response. Not a full agent session. The context is assembled in-memory (no file I/O). Chosen over a direct API call (Session Runtime already handles model provider abstraction, rate limiting, and cost tracking).

**Inference confidence gating: Configurable threshold.** Default 0.6. Below threshold: log the decision, surface on the briefing page under "Needs Attention," and do not act. Above threshold: act immediately. The threshold is a single global value — per-decision-type thresholds add configuration complexity without demonstrated need at this stage.

**Deterministic fallback table.** When the model provider is unavailable, each decision type has a hardcoded fallback: `stuck_detection` → timer-based (exceeded limit = stuck), `retry_skip_replan` → retry once then skip, `impediment_routing` → escalate to operator, `batch_rebalancing` → let finish. Fallbacks are logged with a `degraded: true` flag.

**Per-tick inference budget.** Each tick tracks cumulative inference cost. If the budget is exceeded, remaining decision points in that tick fall back to deterministic rules. Budget resets on the next tick. Consecutive budget exhaustion triggers an operator notification.

**Daemon restart recovery.** On startup, the Coordinator scans `state/coordination/claims/` for active claims. For each: check if the corresponding worker process is alive (PID check). Stale claims (no process) are set to `failed` and their worktrees cleaned up. Active claims (process alive) re-attach monitoring via the Control Plane. The active Batch is resumed from `state/coordination/batches.json`. Merge Agent recovery is handled by STACK-AC-MERGE-AGENT.

**Outage handling: Differentiated by dependency.** Source control unreachable: workers continue locally, PR creation and label operations are deferred with exponential backoff retry. Model provider unreachable during inference: fall back to deterministic rules (see fallback table). Workers that complete during an outage buffer their output (PR opened when host recovers); the Coordinator reconciles claim status on recovery.

**GlobalSettings extension: Config file.** New coordination settings (`max_agents`, `reviewer_interval`, `planner_timeout`, `max_attempts_per_issue`, `disk_space_threshold`, `gc_interval`, `inference_confidence_threshold`, `inference_budget_per_tick`) are added to the existing config schema (STACK-AC-CONVENTIONS `config.ts`). Validated via Zod on startup.

## Examples

```typescript
// InferenceContext — narrow input assembled per decision juncture
const InferenceContextSchema = z.object({
  decisionType: z.enum(['stuck_detection', 'retry_skip_replan', 'impediment_routing', 'batch_rebalancing']),
  workItemId: z.string().nullable(),
  stateSnapshot: z.record(z.unknown()),
  recentActivity: z.array(z.unknown()).max(10),
});
```

```typescript
// InferenceDecision — structured output from lightweight call
const InferenceDecisionSchema = z.object({
  chosenAction: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
```

```typescript
// Confidence gating — act or escalate
async function handleDecision(d: InferenceDecision, cfg: CoordinationConfig) {
  appendToLog(d);
  if (d.confidence < cfg.inferenceConfidenceThreshold) return flagNeedsAttention(d);
  await applyAction(d);
}
```

```typescript
// Deterministic fallback table — model provider unavailable
const fallbacks: Record<string, string> = {
  stuck_detection: 'stuck', retry_skip_replan: 'retry',
  impediment_routing: 'escalate_operator', batch_rebalancing: 'let_finish',
};
```

```typescript
// Concurrency algorithm — tick handler
function evaluatePool(claims: WorkerClaim[], cfg: CoordinationConfig): SpawnDecision[] {
  const active = claims.filter(c => isActiveStatus(c.status));
  if (active.length >= cfg.maxAgents) return [];
  return [...enforceMinimums(active, cfg), ...fillFromQueue(active, cfg)];
}
```

## Gotchas

- The Coordinator tick and inference calls share the event loop. Inference calls are async but bounded by a per-call timeout (default 10 seconds). If a call hangs, the tick falls back to the deterministic rule for that decision point and continues.
- Inference decisions are ephemeral — InferenceContext is not persisted. The inference-log.json stores only InferenceDecisions (outputs) for operator visibility. The log is a ring buffer capped at 100 entries.
- The `retry_skip_replan` fallback retries once, then skips. But the `max_attempts_per_issue` config (default 3) is the authoritative retry cap. The fallback's "retry once" is within the context of a single failure event — the Coordinator still checks the global attempt count before dispatching a retry.
- Protocol orchestration timeouts (default 60 seconds) apply to the full protocol round-trip, not individual messages. If the PO or TL service is slow, the Coordinator dispatches from the existing queue and the protocol result is discarded when it arrives late.
- Git worktree creation requires the base branch to exist locally. If `dev` is not fetched, `git worktree add` fails. Always `git fetch origin dev` before creating a worktree.
- The MCP stdio transport requires the daemon to manage the server process lifecycle. If the terminal disconnects, the server process must be cleaned up. Use `process.on('disconnect')` or stdin close detection.
- WorkerClaim files use `{issue}-{attempt}.json` naming. On retry, attempt increments. Old claim files (failed attempts) are kept for audit but excluded from active claim queries by status check. Active statuses are: `claimed`, `in_progress`, `paused`, `pr_opened`.
- Per-repo concurrency limits come from existing repository configuration (STACK-AC-CONTROL-PLANE). The Coordinator must read this config — it is not duplicated in coordination config.
- The `max_agents` cap includes all pooled agent types (PO, Tech Lead, Worker, Reviewer) but excludes the Merge Agent, which runs outside the pool. The Merge Agent is supervised directly by the Coordinator (restart on unexpected exit unless paused/shutting down).
- Disk space check uses `fs.statfs()` (Node 22+). On macOS, `f_bavail * f_bsize` gives available bytes. Compare against `disk_space_threshold` config. If below threshold, skip all spawns and post a warning to the briefing page.
- The `get_briefing` MCP tool now includes recent inference decisions. Pull from inference-log.json and filter to last N entries (default 5) for the response.
- Daemon restart scans claim files by status, not by process liveness alone. A claim file with status `in_progress` but no running process is stale — set to `failed` and clean up the worktree. Do not attempt to resume a stale claim.
