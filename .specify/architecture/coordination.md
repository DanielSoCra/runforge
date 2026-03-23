---
id: ARCH-AC-COORDINATION
type: architecture
domain: auto-claude
status: draft
version: 2
layer: 2
references: FUNC-AC-COORDINATION
---

# ARCH-AC-COORDINATION — Parallel Agent Coordination

## Overview

The Coordination Service manages multi-run orchestration within the daemon process. It owns the agent pool, batch lifecycle, merge queue, protocol orchestration, concurrency management, and the terminal interface. It coordinates with the Control Plane (which owns individual run lifecycle), the Dashboard (which surfaces coordination state to the operator), and the Knowledge Service (which provides prospective risk signals for batch planning).

Product ownership behavior (proposal generation, signal analysis, operator idea refinement) is architecturally defined in a separate spec governed by FUNC-AC-PRODUCT-OWNER. Technical leadership behavior (code health analysis, effort estimation, failure pattern detection) is defined in a separate spec governed by FUNC-AC-TECH-LEAD. This spec covers the coordination mechanics that both roles participate in: batch planning execution, merge sequencing, concurrency management, inference-augmented decision points, and failure recovery.

The coordination engine is a deterministic state machine augmented with lightweight inference calls at specific decision junctures. These calls receive narrow context and return a single routing decision — they do not generate proposals, modify specs, or initiate protocols.

This spec supersedes the in-memory integration lock in ARCH-AC-CONTROL-PLANE. The Control Plane's `integrate` phase is redefined: instead of acquiring a lock and merging directly, it opens a PR and enqueues a MergeQueueEntry. The Merge Agent (described below) handles the actual merge. Validation moves from pre-merge to post-merge with revert on failure — this prevents serializing all validation on the shared integration branch when multiple agents produce PRs concurrently.

## Data Model

**Batch** represents a planner-created work package agreed upon through the Batch Planning protocol (Protocol 2 in FUNC-AC-COORDINATION). It contains: a unique identifier, a status (`planning`, `active`, `completed`, `cancelled`), a target worker count, a budget estimate (derived from historical per-phase costs), a risk summary (populated from prospective Knowledge Service queries during planning), and timestamps for creation, activation, and completion. Only one Batch can be `active` at a time. The Batch state machine transitions: `planning` → `active` (protocol completes and participants agree), `active` → `completed` (all items merged), `active` → `cancelled` (operator cancels or the Escalation protocol determines the batch is no longer viable). Cancellation stops new dispatches but in-flight workers continue to completion and their PRs still merge normally.

**BatchItem** represents a single issue within a Batch. It contains: a unique identifier, a reference to the Batch, the issue number, a status (`pending`, `in_progress`, `completed`, `skipped`, `failed`), and a list of dependency edges (references to other BatchItem identifiers that must complete before this item is ready). The "ready set" is computed as items whose dependencies are all in a terminal-satisfied state (`completed` or `skipped`). When a dependency reaches `failed`, the coordination engine invokes an inference decision point to determine the response (skip the dependent item, re-plan the batch, or retry the failed dependency), then routes the result through the Escalation protocol if the decision requires PO or Tech Lead input.

**WorkerClaim** represents an active worker assignment. It contains: a unique identifier, the issue number, an attempt number (starts at 1, incremented on retry), a reference to the BatchItem (nullable for immediate dispatch), the worker session identifier, the worktree path, a PR number (set when worker opens PR, null before), an agent type (`worker`, `reviewer`, `po`, `tech_lead`), a status (`claimed`, `in_progress`, `paused`, `pr_opened`, `completed`, `failed`), a failure reason (nullable), and timestamps for creation and last update. A partial uniqueness constraint ensures only one active claim (status in `claimed`, `in_progress`, `paused`, `pr_opened`) per issue number.

**MergeQueueEntry** represents a PR waiting for integration. It contains: a unique identifier, the PR number, a reference to the WorkerClaim, the issue number, the head commit reference at enqueue time, a reference to the Batch (nullable), a priority value (from the dependency order established during the Batch Planning protocol; lower value = merge first), a merge phase (`queued`, `rebasing`, `merging`, `validating`, `reverted`), a status (`queued`, `merging`, `merged`, `failed`, `blocked`, `needs_human`), the merge commit reference (set after successful merge, null before), the number of merge attempts, the last failure reason (nullable), and timestamps for creation and last update. Only one entry can be in an active merge phase (`rebasing`, `merging`, or `validating`) at a time — this serves as a database-backed lock that covers the full merge-through-validation cycle. A configurable validation timeout (default 10 minutes) releases the lock and marks the entry `failed` if validation hangs.

The `merge_phase` field tracks the Merge Agent's current operational step (what it is doing right now). The `status` field tracks the entry's overall outcome lifecycle (its final or operator-facing state). Phase advances within a single merge attempt; status reflects the cumulative result.

**InferenceContext** represents the narrow context assembled for a lightweight inference call at a decision juncture. It contains: the decision type (an enum: `stuck_detection`, `retry_skip_replan`, `impediment_routing`, `batch_rebalancing`), the work item identifier (nullable — not all decisions are item-scoped), a state snapshot (the current status of the relevant work item or batch), recent activity (a bounded window of recent events for the item or batch, default last 10 events), and a failure reason (nullable — present for retry/skip and impediment routing decisions). The context is assembled by the coordination engine from in-memory and database state. It is ephemeral — not persisted after the decision is made.

**InferenceDecision** represents the output of a lightweight inference call. It contains: the decision type (matching the context), a chosen action (enum values depend on decision type — see Event Flows for the specific action sets per type), a confidence score (provided by the inference call), and a brief rationale (a short text explanation for operator visibility in logs and the briefing page). The coordination engine acts on the chosen action by transitioning the state machine. If confidence is below a configurable threshold (default 0.6), the decision is escalated to the operator instead of being acted on automatically.

**Extensions to existing models:**

- **GlobalSettings** gains: `max_agents` (hard safety cap, default 10), `reviewer_interval` (schedule for the reviewer agent), `planner_timeout` (maximum seconds to wait for a protocol decision, default 60), `max_attempts_per_issue` (claim-level retry cap, distinct from per-phase retries in the Control Plane, default 3), `disk_space_threshold` (minimum free disk space before spawn is blocked, default 2 GB), `gc_interval` (orphaned workspace garbage collection interval, default 10 minutes), `conflict_file_threshold` (maximum conflicting files for automatic resolution, default 3), `conflict_line_threshold` (maximum conflict lines for automatic resolution, default 100), `merge_dependency_timeout` (time before an unfulfilled merge dependency is marked blocked, default 30 minutes), `merge_validation_timeout` (time before a hung validation releases the merge lock and fails the entry, default 10 minutes), `inference_confidence_threshold` (minimum confidence for automatic action on inference decisions, default 0.6), `inference_budget_per_tick` (maximum inference call cost per tick cycle, default configurable).
- **Run** gains: `worker_claim_id` (reference to WorkerClaim, linking a run to the worker that produced it). A single WorkerClaim may produce one or more Runs.

## API Contract

The Coordination Service exposes operations through a terminal interface server, enabling conversational access from any terminal session. Proposal and idea operations are owned by the Product Ownership service (see FUNC-AC-PRODUCT-OWNER); the terminal interface routes those calls through to the PO service.

**Status operations:**

- `get_briefing` — Parameters: none. Returns: active workers count, merge queue depth, batch status, recent completions, items needing attention, recent inference decisions (for operator visibility). Status: success.
- `get_active_work` — Parameters: none. Returns: array of active WorkerClaims with issue details, agent type, status, duration. Status: success.
- `get_batch_plan` — Parameters: none. Returns: active Batch with dependency graph, BatchItem statuses, target vs actual worker count, risk summary from prospective knowledge check. Status: success or no active batch.

**Control operations:**

- `pause_daemon` / `resume_daemon` — Parameters: none. Returns: acknowledgment. Delegates to the Control Plane's existing pause/resume. Status: success, already paused, or not paused.
- `cancel_batch` — Parameters: optional batch identifier (defaults to active Batch). Returns: acknowledgment. Sets Batch status to `cancelled`. Status: success, not found, or no active batch.
- `reprioritize_issue` — Parameters: issue number, new priority (higher/lower/specific position). Returns: acknowledgment. Status: success or not found.

**Error contract:** All operations return structured errors with: an error code (`not_found`, `invalid_state`, `unauthorized`, `validation_error`), a human-readable message, and the operation name. Authentication uses the daemon's existing credential model.

## System Boundaries

**Coordination Service OWNS:** Batch, BatchItem, WorkerClaim, MergeQueueEntry, agent pool, concurrency algorithm, merge queue, protocol orchestration (triggering and sequencing PO/TL protocols), inference decision points, terminal interface server.

**Coordination Service CALLS:** Control Plane (to spawn and monitor individual runs), Session Runtime (to spawn worker, reviewer, and Merge Agent sessions, and to execute lightweight inference calls at decision junctures), Validation Service (to run post-merge validation), Knowledge Service (to query prospective risks before batch planning), Product Ownership Service (to trigger and collect inputs for Batch Planning, Escalation, and Status Sync protocols), Technical Leadership Service (to trigger and collect inputs for Batch Planning, Escalation, and Status Sync protocols).

**Coordination Service READS:** work request source (for batch planning inputs), cost history (for budget estimation).

**Coordination Service WRITES:** work request labels (claiming for workers, updating on merge), merge operations on the integration branch.

**Control Plane NOTIFIES:** Coordination Service when a run completes, fails, or gets stuck — enabling WorkerClaim status updates and batch re-evaluation.

**Product Ownership Service PROVIDES:** prioritized work items for batch planning (Protocol 2), priority decisions for escalations (Protocol 4), status updates for sync (Protocol 5). The PO service owns Proposal and IdeaSubmission data models, proposal lifecycle, and operator idea refinement. The Coordination Service consumes PO outputs but does not manage PO state.

**Technical Leadership Service PROVIDES:** dependency graphs, capacity assessments, effort estimates, and technical risk flags for batch planning (Protocol 2), technical blocker analysis for escalations (Protocol 4), system health reports for sync (Protocol 5). The TL service owns finding analysis, spec-code drift detection, and failure pattern recognition. The Coordination Service consumes TL outputs but does not manage TL state.

**Dashboard READS:** Coordination Service state (Batches, WorkerClaims, MergeQueueEntries, recent inference decisions) for operator visibility. The Dashboard gains active Batch status, worker grid, merge queue status, and inference decision log.

**Relationship to ARCH-AC-CONTROL-PLANE:** The Control Plane retains ownership of RunState, pipeline FSM, phase execution, classification, stuck handling, and crash-safe state writes. The Coordination Service sits above the Control Plane — it decides which work to dispatch and when, while the Control Plane handles how each individual run executes.

**Agent roles and pool:** Five agent types consume a shared pool of N slots (configurable via `GlobalSettings.max_agents`, default 10). The PO Agent (min 1, max 1) proposes features on a configurable schedule — its behavior is governed by the Product Ownership architecture spec. The Tech Lead Agent (min 1, max 1) monitors code health on a configurable schedule — its behavior is governed by the Technical Leadership architecture spec. Worker Agents (min 1, max configurable) execute tasks dispatched through batch planning. The Reviewer Agent (min 1, max 1) proactively scans the codebase on a configurable schedule. The Merge Agent runs outside the pool so it is never blocked by pool exhaustion — it is infrastructure, not a pooled agent. The Coordinator supervises the Merge Agent and restarts it on unexpected exit (unless the daemon is paused or shutting down).

**Concurrency algorithm:** The coordinator evaluates on every tick and on worker completion. It first ensures per-type minimums are met, then fills from the immediate dispatch queue (unbatched independent work approved by PO for immediate dispatch), then fills from the active Batch's ready set. Per-type maximums prevent starvation. Per-repository concurrency limits (from existing repository configuration) prevent a single repository from consuming all slots. A disk space guard (configurable threshold, default 2 GB) prevents spawning when resources are low and alerts the operator via the briefing page.

**Work claiming:** The coordinator claims issues atomically in the database (partial uniqueness constraint on issue number for active statuses). Labels are applied after the claim succeeds — labels reflect state, they do not drive it. The database is the source of truth. Workers never pick their own work, never modify labels, never merge to the integration branch.

**Worker isolation:** Each worker operates in its own isolated workspace created from the latest integration branch at spawn time. Workers commit to a task-specific branch and open a PR on completion. A periodic garbage collection pass (configurable interval, default 10 minutes) removes orphaned workspaces with no active WorkerClaim.

**Budget and safety:** The global max agents cap is a hard safety limit enforced regardless of protocol decisions. Per-session budget caps are configurable per skill type. Batch budget is estimated from historical costs and is advisory — if it exceeds the daily budget, a warning is posted instead of executing. Runtime cost enforcement relies on per-session and daily budget caps; batch budget is a planning heuristic, not a runtime guard. The operator can pause, reprioritize, or cancel at any time. Inference calls consume model credits and are tracked against a per-tick inference budget to prevent runaway inference costs.

**Affected specs requiring updates:** ARCH-AC-CONTROL-PLANE (remove integration lock, redefine `integrate` phase to open PR and enqueue MergeQueueEntry, add Coordination Service notification clause, standardize on 'integration branch' terminology), FUNC-AC-PIPELINE (add parallel dispatch and batch lifecycle scenarios), ARCH-AC-DASHBOARD (add new data model entities, rename `concurrency_limit` to `max_agents`, add inference decision log).

## Event Flows

**Batch planning (Protocol 2 execution):**

1. The coordination engine triggers the Batch Planning protocol when the previous batch completes or when the operator requests a new batch.
2. The PO service provides the top N items from the backlog, ordered by business priority.
3. The Tech Lead service provides a dependency graph, capacity assessment, current system health, and effort estimates.
4. The coordination engine queries the Knowledge Service for prospective risks related to the planned work areas. High-severity knowledge records are included in the Tech Lead's input.
5. Single round-trip negotiation: the Tech Lead flags hard constraints (dependencies, parallelism limits, capacity); the PO adjusts selection based on technical reality. If they cannot converge in one round, both positions go to the operator for resolution.
6. On agreement: the coordination engine creates a Batch with BatchItems, dependency edges, and a risk summary. The Batch transitions from `planning` to `active`.
7. On protocol timeout (configurable, default 60 seconds): the coordination engine dispatches from the existing batch queue without re-planning.

**Work dispatch:**

1. The PO service or operator creates work (proposal approval creates a work request, or operator creates a work request directly). Proposal lifecycle is managed by the Product Ownership service.
2. The coordination engine evaluates ready work through the Batch Planning protocol: PO prioritizes, Tech Lead provides dependency analysis, and related issues form a Batch. Independent issues approved by the PO for immediate dispatch enter the immediate dispatch queue.
3. The Coordinator runs the concurrency algorithm. For each issue to dispatch: claim atomically in the database, apply work request labels, create an isolated workspace from the integration branch, spawn a worker via Session Runtime.
4. The worker executes its task through the Control Plane's pipeline FSM.
5. On completion: the worker opens a PR. The Coordinator updates WorkerClaim status to `pr_opened` and enqueues a MergeQueueEntry.

**Merge queue processing:**

1. The Merge Agent polls for `queued` entries, selects the highest-priority entry whose dependencies are satisfied. Dependency order follows the Batch definition — if PR A depends on PR B, B merges first even if A completed earlier. PRs outside a Batch merge in FIFO order. If a dependency is unfulfilled beyond a configurable timeout (default 30 minutes), the entry is marked `blocked`.
2. Rebase the PR branch onto the integration branch.
3. If no conflict: merge (no-fast-forward, atomic single commit). If a conflict exists and is small (configurable thresholds: default 3 or fewer files, 100 or fewer conflict lines): spawn a conflict resolution session with the conflicting files, specification context, and a per-session budget cap. If the conflict is large or resolution fails: mark `needs_human`, notify the operator.
4. On successful merge: update phase to `validating`, run the validation suite. If validation passes: mark `merged`, delete the task branch, clean up the workspace. If validation fails: revert the merge commit, mark `failed`, notify the coordination engine.
5. The coordination engine invokes an inference decision point (type: `retry_skip_replan`) to determine whether to retry, skip, or re-plan. If the decision requires PO or Tech Lead input, it routes through the Escalation protocol.

**Batch lifecycle:**

1. The coordination engine triggers the Batch Planning protocol (see above). Output: a Batch in `active` status.
2. Coordinator dispatches workers for ready BatchItems.
3. As workers complete and merge, the coordination engine monitors progress. Three reaction levels to incoming events: no impact (queue for next batch or dispatch immediately), related (absorb into current scope or create follow-up), invalidating (pause affected worker by transitioning its WorkerClaim to `paused` and signaling the Control Plane to suspend the run, then trigger re-planning through the Batch Planning protocol).
4. All items complete and merge → Batch transitions to `completed`. The coordination engine triggers a Retrospective protocol (Protocol 6), then proceeds to the next Batch Planning protocol. If the operator cancels or the PO escalates a higher-priority interrupt through the Escalation protocol → Batch transitions to `cancelled`.

**Inference-augmented decision points:**

The coordination engine encounters decision junctures where deterministic rules are insufficient. At each juncture:

1. The coordination engine assembles an InferenceContext from current state: decision type, work item state, recent activity window, and failure reason (if applicable).
2. The coordination engine submits the context to Session Runtime for a lightweight inference call. This is a single-turn call with narrow context — not a full agent session.
3. Session Runtime returns an InferenceDecision: chosen action, confidence, and rationale.
4. If confidence is at or above the threshold (default 0.6): the coordination engine acts on the chosen action by transitioning the state machine.
5. If confidence is below threshold: the decision is logged and escalated to the operator via the briefing page under "Needs Attention."

**Decision types and action sets:**

| Decision type | Trigger | Action set | Post-action |
|---|---|---|---|
| `stuck_detection` | Work item exceeds time or budget limit | `stuck` (confirm stuck), `not_stuck` (extend deadline) | If stuck: route to `retry_skip_replan` |
| `retry_skip_replan` | Work item confirmed stuck or merge validation failed | `retry`, `skip`, `replan` | retry: new WorkerClaim with incremented attempt; skip: mark BatchItem skipped; replan: trigger Batch Planning protocol |
| `impediment_routing` | Work item has a blocker that requires external input | `escalate_po` (business/priority issue), `escalate_tl` (technical blocker), `escalate_operator` (resource constraint or ambiguous) | Route through Escalation protocol (Protocol 4) to the appropriate party |
| `batch_rebalancing` | Batch velocity significantly above or below estimate | `pull_in` (add work from backlog), `let_finish` (no change), `shed_load` (defer low-priority items) | pull_in: trigger abbreviated Batch Planning; shed_load: move items to next batch |

**Protocol timeout fallback:** If the PO or Tech Lead has not responded within the configured timeout (default 60 seconds), the Coordinator dispatches from the existing batch queue without re-planning.

## Error Handling

**Worker crash:** The daemon detects the worker process exited unexpectedly. WorkerClaim status is set to `failed` with reason. The workspace is cleaned up. If the worker had pushed a partial branch, it is deleted. The coordination engine invokes an inference decision point (`retry_skip_replan`) to determine the response. Work request labels are reverted to their previous state.

**Worker stuck (exceeds time or budget limit):** The coordination engine invokes an inference decision point (`stuck_detection`) to determine whether the item is truly stuck or just complex. If confirmed stuck: the Coordinator terminates the worker process, sets WorkerClaim to `failed`, and invokes `retry_skip_replan`. If not stuck: the deadline is extended (within configurable bounds). The issue is flagged on the briefing page under "Needs Attention" with the inference rationale.

**Merge Agent crash:** MergeQueueEntry retains its current `merge_phase`. On restart, the Merge Agent checks entries with non-terminal phases: for `rebasing` or `merging`, it checks whether the merge commit exists on the integration branch (if yes, advance to `validating`; if no, reset to `queued` and retry); for `validating`, it re-runs validation; for `reverted`, it marks the entry as `failed`. Recovery is deterministic because each phase has a clear observable outcome.

**Daemon restart:** Read all WorkerClaims with active status. Check if corresponding worker processes are alive. Stale claims (no process): set to `failed`, clean up workspaces. Active claims (process alive): re-attach monitoring. Resume the active Batch from database state. Merge Agent recovers non-terminal entries. Workspace garbage collection removes orphans.

**Database unreachable:** Coordinator stops dispatching new work. In-flight workers continue on local workspaces. Merge Agent pauses. Daemon retries with exponential backoff. Workers that complete buffer their results (PR opened on the source control host) and the Coordinator reconciles when the database recovers.

**Source control host unreachable:** Workers can still commit locally but cannot open PRs. WorkerClaim stays at `in_progress` until the host recovers. Coordinator retries label operations with backoff.

**Differentiated outage policy:** The three external-dependency failure modes have intentionally different responses. Database outage halts all coordination (dispatch, merging, claiming) because the database is the source of truth for all state. Source control outage is partial — workers continue locally, only PR creation and label operations are deferred. Model provider failure during conflict resolution is narrow — only the specific merge entry is affected, and human fallback is immediate. This differentiation follows the L1 principle of continuing where possible while pausing what depends on the unavailable service.

**Model provider failure during conflict resolution:** Merge Agent skips LLM resolution, marks the entry as `needs_human`. Does not retry model calls — waits for the next merge attempt or human intervention.

**Model provider failure during inference decision:** The coordination engine falls back to deterministic rules for the decision type: stuck detection defaults to timer-based ("exceeded limit = stuck"), retry/skip defaults to "retry once then skip," impediment routing defaults to "escalate to operator," batch rebalancing defaults to "let finish." The fallback is logged with a flag indicating degraded mode. Normal inference resumes when the model provider recovers.

**Merge validation failure:** The merge commit is reverted (single atomic commit). The MergeQueueEntry phase is set to `reverted`, status to `failed`. The coordination engine invokes an inference decision point (`retry_skip_replan`) to determine whether to re-dispatch a worker to fix the issue or re-plan the Batch.

**Dependency timeout in merge queue:** If a MergeQueueEntry's dependency has not been fulfilled within the configurable timeout (default 30 minutes), the entry is marked `blocked` and flagged on the briefing page for operator attention.

**Inference budget exhaustion:** If the per-tick inference budget is exceeded, remaining decision points in that tick fall back to deterministic rules. Budget resets on the next tick. The operator is notified if inference budget exhaustion occurs on consecutive ticks.

**Protocol participant unavailable:** If the PO or Tech Lead service is unavailable when a protocol is triggered, the coordination engine queues the protocol invocation and retries on the next tick. Time-critical escalations (budget exceeded, system down) bypass protocol and go directly to the operator.
