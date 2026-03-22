---
id: ARCH-AC-COORDINATION
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-COORDINATION
---

# ARCH-AC-COORDINATION — Parallel Agent Coordination

## Overview

The Coordination Service manages multi-run orchestration within the daemon process. It owns the agent pool, batch lifecycle, merge queue, product ownership cycle, and the terminal interface. It coordinates with the Control Plane (which owns individual run lifecycle) and the Dashboard (which surfaces coordination state to the operator). The system runs as a single process — the Coordination Service is a logical boundary, not a separate deployment.

This spec supersedes the in-memory integration lock in ARCH-AC-CONTROL-PLANE. The Control Plane's `integrate` phase is redefined: instead of acquiring a lock and merging directly, it opens a PR and enqueues a MergeQueueEntry. The Merge Agent (described below) handles the actual merge. Validation moves from pre-merge to post-merge with revert on failure — this prevents serializing all validation on the shared integration branch when multiple agents produce PRs concurrently.

## Data Model

**Proposal** represents a feature suggestion produced by the PO agent, awaiting operator decision. It contains: a unique identifier, a title, a rationale, an estimated scope (`small`, `medium`, `large`), a status (`proposed`, `approved`, `rejected`, `deferred`), links to related specs and issues, the approved issue number (set when the operator approves and a work request is created, null otherwise), the approving user reference, operator decision notes (null until acted on), an expiry timestamp (configurable, default 30 days from creation), and timestamps for creation and decision.

**Batch** represents a planner-created work package. It contains: a unique identifier, a status (`planning`, `active`, `completed`, `cancelled`), a target worker count, a budget estimate (derived from historical per-phase costs), and timestamps for creation, activation, and completion. Only one Batch can be `active` at a time. The Batch state machine transitions: `planning` → `active` (planner finalizes), `active` → `completed` (all items merged), `active` → `cancelled` (operator cancels or planner determines batch is no longer viable). Cancellation stops new dispatches but in-flight workers continue to completion and their PRs still merge normally.

**BatchItem** represents a single issue within a Batch. It contains: a unique identifier, a reference to the Batch, the issue number, a status (`pending`, `in_progress`, `completed`, `skipped`), and a list of dependency edges (references to other BatchItem identifiers that must complete before this item is ready). The "ready set" is computed as items whose dependencies are all in status `completed`.

**WorkerClaim** represents an active worker assignment. It contains: a unique identifier, the issue number, an attempt number (starts at 1, incremented on retry), a reference to the BatchItem (nullable for immediate dispatch), the worker session identifier, the worktree path, a PR number (set when worker opens PR, null before), an agent type (`worker`, `reviewer`, `po`, `planner`), a status (`claimed`, `in_progress`, `pr_opened`, `completed`, `failed`), a failure reason (nullable), and timestamps for creation and last update. A partial uniqueness constraint ensures only one active claim (status in `claimed`, `in_progress`, `pr_opened`) per issue number.

**MergeQueueEntry** represents a PR waiting for integration. It contains: a unique identifier, the PR number, a reference to the WorkerClaim, the issue number, the head commit reference at enqueue time, a reference to the Batch (nullable), a priority value (from the planner's dependency order; lower value = merge first), a merge phase (`queued`, `rebasing`, `merging`, `validating`, `validated`, `reverted`), a status (`queued`, `merging`, `merged`, `failed`, `blocked`, `needs_human`), the merge commit reference (set after successful merge, null before), the number of merge attempts, the last failure reason (nullable), and timestamps for creation and last update. Only one entry can be in a `merging` phase at a time — this serves as a database-backed lock.

**IdeaSubmission** represents an operator-submitted idea to the PO's inbox. It contains: a unique identifier, the submitting user reference, a description (freeform text), a status (`pending`, `processed`), the resulting Proposal reference (set when PO produces a Proposal from this idea, null otherwise), and a creation timestamp.

**Extensions to existing models:**

- **GlobalSettings** gains: `max_agents` (hard safety cap, default 10), `reviewer_interval` (schedule for the reviewer agent), `po_interval` (schedule for the PO agent), `planner_timeout` (maximum seconds to wait for a planner decision, default 60).
- **Run** gains: `worker_claim_id` (reference to WorkerClaim, linking a run to the worker that produced it). A single WorkerClaim may produce one or more Runs.

## API Contract

The Coordination Service exposes operations through a terminal interface server, enabling conversational access from any terminal session.

**Proposal operations:**

- `list_proposals` — Parameters: optional status filter. Returns: array of Proposals matching the filter (defaults to `proposed`). Status: success.
- `submit_idea` — Parameters: description (text). Returns: IdeaSubmission identifier. Creates an IdeaSubmission and triggers debounced PO evaluation. Status: success or validation error.
- `approve_proposal` — Parameters: proposal identifier, optional decision notes. Returns: created issue number. Transitions the Proposal to `approved` and creates a work request. Status: success, not found, or invalid state (already decided).
- `reject_proposal` — Parameters: proposal identifier, optional decision notes. Returns: acknowledgment. Transitions the Proposal to `rejected`. Status: success, not found, or invalid state.

**Status operations:**

- `get_briefing` — Parameters: none. Returns: active workers count, merge queue depth, batch status, recent completions, items needing attention. Status: success.
- `get_active_work` — Parameters: none. Returns: array of active WorkerClaims with issue details, agent type, status, duration. Status: success.
- `get_batch_plan` — Parameters: none. Returns: active Batch with dependency graph, BatchItem statuses, target vs actual worker count. Status: success or no active batch.

**Control operations:**

- `pause_daemon` / `resume_daemon` — Parameters: none. Returns: acknowledgment. Delegates to the Control Plane's existing pause/resume. Status: success, already paused, or not paused.
- `cancel_batch` — Parameters: optional batch identifier (defaults to active Batch). Returns: acknowledgment. Sets Batch status to `cancelled`. Status: success, not found, or no active batch.
- `reprioritize_issue` — Parameters: issue number, new priority (higher/lower/specific position). Returns: acknowledgment. Status: success or not found.

**Error contract:** All operations return structured errors with: an error code (`not_found`, `invalid_state`, `unauthorized`, `validation_error`), a human-readable message, and the operation name. Authentication uses the daemon's existing credential model.

## System Boundaries

**Coordination Service OWNS:** Proposal, Batch, BatchItem, WorkerClaim, MergeQueueEntry, IdeaSubmission, agent pool, concurrency algorithm, merge queue, PO cycle, terminal interface server.

**Coordination Service CALLS:** Control Plane (to spawn and monitor individual runs), Session Runtime (to spawn PO, Planner, and Merge Agent sessions), Validation Service (to run post-merge validation).

**Coordination Service READS:** work request source (for batch planning inputs), cost history (for budget estimation).

**Coordination Service WRITES:** work request labels (claiming for workers, updating on merge), merge operations on the integration branch.

**Control Plane NOTIFIES:** Coordination Service when a run completes, fails, or gets stuck — enabling WorkerClaim status updates and batch re-evaluation.

**Dashboard READS:** Coordination Service state (Proposals, Batches, WorkerClaims, MergeQueueEntries) for operator visibility. The Dashboard gains a "Proposed" briefing section, active Batch status, worker grid, merge queue status, and a kanban board for PO interaction.

**Relationship to ARCH-AC-CONTROL-PLANE:** The Control Plane retains ownership of RunState, pipeline FSM, phase execution, classification, stuck handling, and crash-safe state writes. The Coordination Service sits above the Control Plane — it decides which work to dispatch and when, while the Control Plane handles how each individual run executes.

**Agent roles and pool:** Five agent types consume a shared pool of N slots (configurable via `GlobalSettings.max_agents`, default 10). The PO Agent (min 1, max 1) proposes features on a configurable schedule. The Planner Agent (min 0, max 1) groups work into batches and monitors progress. Worker Agents (min 1, max configurable) execute tasks dispatched by the Planner. The Reviewer Agent (min 1, max 1) proactively scans the codebase on a configurable schedule. The Merge Agent (always 1) runs outside the pool so it is never blocked by pool exhaustion — it is infrastructure, not a pooled agent.

**Concurrency algorithm:** The coordinator evaluates on every tick and on worker completion. It first ensures per-type minimums are met, then fills from the immediate dispatch queue (unbatched independent work), then fills from the active Batch's ready set. Per-type maximums prevent starvation. Per-repository concurrency limits (from existing repository configuration) prevent a single repository from consuming all slots. A disk space guard (configurable threshold, default 2 GB) prevents spawning when resources are low.

**Work claiming:** The coordinator claims issues atomically in the database (partial uniqueness constraint on issue number for active statuses). Labels are applied after the claim succeeds — labels reflect state, they do not drive it. The database is the source of truth. Workers never pick their own work, never modify labels, never merge to the integration branch.

**Worker isolation:** Each worker operates in its own isolated workspace created from the latest integration branch at spawn time. Workers commit to a task-specific branch and open a PR on completion. A periodic garbage collection pass (configurable interval, default 10 minutes) removes orphaned workspaces with no active WorkerClaim.

**Budget and safety:** The global max agents cap is a hard safety limit enforced regardless of planner decisions. Per-session budget caps are configurable per skill type. Batch budget is estimated from historical costs — if it exceeds the daily budget, the Planner posts a warning instead of executing. Proposals never auto-execute (operator approval required). The operator can pause, reprioritize, or cancel at any time.

**Affected specs requiring updates:** ARCH-AC-CONTROL-PLANE (remove integration lock, redefine `integrate` phase), FUNC-AC-PIPELINE (add parallel dispatch and batch lifecycle scenarios), ARCH-AC-DASHBOARD (add new data model entities, rename `global_concurrency_limit` to `max_agents`).

## Event Flows

**Work dispatch:**

1. The PO agent or operator creates work (Proposal → approval → work request, or direct work request creation).
2. The Planner evaluates ready work: groups related issues into a Batch with a dependency graph and budget estimate. Issues sharing a parent specification, touching the same subsystem, or with explicit dependencies form a natural Batch. Independent issues enter the immediate dispatch queue.
3. The Coordinator runs the concurrency algorithm. For each issue to dispatch: claim atomically in the database, apply work request labels, create an isolated workspace from the integration branch, spawn a worker via Session Runtime.
4. The worker executes its task through the Control Plane's pipeline FSM.
5. On completion: the worker opens a PR. The Coordinator updates WorkerClaim status to `pr_opened` and enqueues a MergeQueueEntry.

**Merge queue processing:**

1. The Merge Agent polls for `queued` entries, selects the highest-priority entry whose dependencies are satisfied. Dependency order follows the Batch definition — if PR A depends on PR B, B merges first even if A completed earlier. PRs outside a Batch merge in FIFO order. If a dependency is unfulfilled beyond a configurable timeout (default 30 minutes), the entry is marked `blocked`.
2. Rebase the PR branch onto the integration branch.
3. If no conflict: merge (no-fast-forward, atomic single commit). If a conflict exists and is small (configurable thresholds: default 3 or fewer files, 100 or fewer conflict lines): spawn a conflict resolution session with the conflicting files, specification context, and a per-session budget cap. If the conflict is large or resolution fails: mark `needs_human`, notify the operator.
4. On successful merge: update phase to `validating`, run the validation suite. If validation passes: mark `merged`, delete the task branch, clean up the workspace. If validation fails: revert the merge commit, mark `failed`, notify the Planner.
5. The Planner evaluates whether to retry, skip, or re-plan.

**Batch lifecycle:**

1. Planner creates a Batch in `planning` status with BatchItems and dependency edges.
2. Planner finalizes → Batch transitions to `active`.
3. Coordinator dispatches workers for ready BatchItems.
4. As workers complete and merge, the Planner monitors progress. Three reaction levels to incoming events: no impact (queue for next batch or dispatch immediately), related (absorb into current scope or create follow-up), invalidating (pause affected worker, re-plan). The Planner reads two dependency sources: the specification chain (traceability map) and explicit blocked-by references in issue metadata.
5. All items complete and merge → Batch transitions to `completed`. Planner creates the next Batch. If the operator cancels or a higher-priority interrupt arrives → Batch transitions to `cancelled`.

**PO cycle:**

1. PO agent runs on schedule (configurable interval) or when an IdeaSubmission arrives (debounced — at most once per interval).
2. PO reads inputs: codebase state, specifications, findings, inbox, system health.
3. PO produces Proposals and stores them in the database.
4. Dashboard displays Proposals in the "Proposed" section.
5. Operator approves or rejects via dashboard or terminal. On approval: work request created, enters the pipeline. The PO never auto-approves its own Proposals.

**Planner timeout fallback:** If the Planner has not responded within the configured timeout (default 60 seconds), the Coordinator dispatches from the existing batch queue without re-planning.

## Error Handling

**Worker crash:** The daemon detects the worker process exited unexpectedly. WorkerClaim status is set to `failed` with reason. The workspace is cleaned up. If the worker had pushed a partial branch, it is deleted. The Planner decides whether to retry (new WorkerClaim with incremented attempt number) or skip. Work request labels are reverted to their previous state.

**Worker stuck (exceeds time or budget limit):** The Coordinator terminates the worker process. WorkerClaim is set to `failed` with reason. The Planner may retry with a higher budget, skip, or re-plan. The issue is flagged on the briefing page under "Needs Attention."

**Merge Agent crash:** MergeQueueEntry retains its current `merge_phase`. On restart, the Merge Agent checks entries with non-terminal phases: for `rebasing` or `merging`, it checks whether the merge commit exists on the integration branch (if yes, advance to `validating`; if no, reset to `queued` and retry); for `validating`, it re-runs validation; for `reverted`, it marks the entry as `failed`. Recovery is deterministic because each phase has a clear observable outcome.

**Planner crash:** The active Batch persists in the database. On restart, the Planner reads the active Batch and resumes monitoring. In-flight workers continue independently. The Planner re-evaluates Batch state against current WorkerClaims and MergeQueueEntries.

**Daemon restart:** Read all WorkerClaims with active status. Check if corresponding worker processes are alive. Stale claims (no process): set to `failed`, clean up workspaces. Active claims (process alive): re-attach monitoring. Resume the active Batch from database state. Merge Agent recovers non-terminal entries. Workspace garbage collection removes orphans.

**Database unreachable:** Coordinator stops dispatching new work. In-flight workers continue on local workspaces. Merge Agent pauses. Daemon retries with exponential backoff. Workers that complete buffer their results (PR opened on the source control host) and the Coordinator reconciles when the database recovers.

**Source control host unreachable:** Workers can still commit locally but cannot open PRs. WorkerClaim stays at `in_progress` until the host recovers. Coordinator retries label operations with backoff.

**Model provider failure during conflict resolution:** Merge Agent skips LLM resolution, marks the entry as `needs_human`. Does not retry model calls — waits for the next merge attempt or human intervention.

**Merge validation failure:** The merge commit is reverted (single atomic commit). The MergeQueueEntry phase is set to `reverted`, status to `failed`. The Planner is notified and decides whether to re-dispatch a worker to fix the issue or re-plan the Batch.

**Dependency timeout in merge queue:** If a MergeQueueEntry's dependency has not been fulfilled within the configurable timeout (default 30 minutes), the entry is marked `blocked` and flagged on the briefing page for operator attention.
