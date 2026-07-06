---
date: 2026-03-22
status: superseded
superseded_by: .specify/L0-ac-vision.md  # unified L0-AC-VISION v5 + its L1 children (per the 2026-05-29 spec-reconciliation ledger)
superseded_date: 2026-06-02
---

> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Parallel Agent Coordination Design

## Problem

The daemon runs agents serially — one task at a time, one shared working tree. When all L1 specs are implemented and multiple work streams exist simultaneously (feature development, bug fixes, spec generation, code review), serial execution wastes capacity. Running agents in parallel introduces merge conflicts, work duplication, and coordination failures that don't exist in serial mode.

## Goals

- Multiple agents work on independent tasks simultaneously
- Merge conflicts are resolved automatically (git-first, LLM fallback)
- Work is planned and ordered by dependency, not grabbed randomly
- The operator's primary interface is the dashboard and Claude Code terminal, not GitHub
- A Product Owner agent proactively proposes new features
- Safety caps prevent runaway cost or concurrency

## Non-Goals

- Distributed execution across multiple machines (single daemon process)
- Real-time collaboration between agents on the same task
- Replacing the operator's judgment on product direction (PO proposes, operator decides)

## Architecture

### Agent Roles

Five agent types form two logical teams plus shared infrastructure:

**Product & Planning:**

| Agent | Purpose | Min | Max | Trigger |
|-------|---------|-----|-----|---------|
| PO | Proposes features, refines operator ideas, produces Proposals | 1 | 1 | Scheduled job (configurable interval) + operator input |
| Planner | Groups work into batches, orders by dependency, monitors and re-plans | 0 | 1 | Batch complete, new events, stuck workers |

**Execution:**

| Agent | Purpose | Min | Max | Trigger |
|-------|---------|-----|-----|---------|
| Worker | Executes any task (specs, implementation, bug fixes) using appropriate skill | 1 | configurable | Planner dispatches |
| Reviewer | Proactively scans codebase for issues, creates review-finding issues | 1 | 1 | Scheduled job (configurable interval) |

**Infrastructure (outside agent pool):**

| Agent | Purpose | Always | Trigger |
|-------|---------|--------|---------|
| Merge Agent | Consumes merge queue in dependency order, runs tests, reverts if broken | 1 | Polls MergeQueueEntry table |

**Worker vs Reviewer:** Both execute tasks, but Workers are reactive (dispatched by the Planner for a specific issue) while the Reviewer is proactive (runs on a schedule, scans the codebase, creates new issues). The Reviewer's min=1 ensures continuous code quality monitoring. Its output (review-finding issues) feeds back into the Planner's queue as potential work for Workers.

**PO Agent:** Runs as a scheduled job with singleton lease (only one instance at a time, not a persistent service). Triggered on schedule or when the operator submits an idea. Proposals expire if not acted on within a configurable window (default: 30 days).

### Agent Pool

A shared pool of N agent slots, configured via `GlobalSettings.max_agents` (default: 10). All agent types (PO, Planner, Worker, Reviewer) consume slots from this pool. The Merge Agent runs outside the pool.

Example: With `max_agents=5`, Reviewer min=1, Worker min=1: on startup, 2 slots are consumed by minimums, leaving 3 for planner-driven dispatch.

- **Global max agents** is a hard safety cap. The daemon never spawns more agents than this regardless of planner decisions.
- **Planner decides actual concurrency** per batch — may use 3 workers for a small batch, 8 for a large independent set. The planner's target is a request, not a guarantee.
- **Per-type min** guarantees reserved capacity (Reviewer min=1 ensures continuous code review).
- **Per-type max** prevents starvation (e.g., max workers for a type prevents one type from consuming all slots).
- **Per-repo max** is enforced from the existing `Repo.concurrency_limit` field. A single repo cannot consume more slots than its configured limit.
- **Merge Agent runs outside the pool** — it is infrastructure, not an agent. It must never be blocked because all slots are full.

### Concurrency Algorithm

The daemon coordinator evaluates on every tick and on worker completion events:

```
available_slots = GlobalSettings.max_agents - count(active WorkerClaims)

# 1. Ensure per-type minimums are met first
for each agent type with min > 0 and active_count < min:
    if available_slots > 0:
        spawn agent of this type
        available_slots -= 1

# 2. Fill from immediate dispatch queue (unbatched independent work)
for each issue in immediate_dispatch_queue:
    if available_slots > 0
       and type_count < type_max
       and repo_active_count < repo.concurrency_limit:
        claim and spawn worker for issue
        available_slots -= 1

# 3. Fill remaining slots from planner's active batch
if active_batch exists:
    planner_target = min(batch.target_worker_count - batch.active_workers, available_slots)
    for i in 1..planner_target:
        next_issue = batch.next_ready_issue()  # unblocked + unclaimed
        if next_issue
           and type_count < type_max
           and repo_active_count < repo.concurrency_limit:
            claim and spawn worker for next_issue

# 4. Planner timeout fallback
if planner has not responded within planner_timeout (default: 60s):
    dispatch from existing batch queue without re-planning
```

### Work Claiming

The daemon coordinator (single process) assigns all work:

1. Planner decides which issue to dispatch and to which worker type.
2. Coordinator claims the issue atomically in Supabase (INSERT into WorkerClaim with partial unique constraint on issue number for active statuses). No race conditions.
3. Coordinator applies the GitHub label after the claim succeeds. Labels reflect state — they do not drive it. Supabase is the source of truth.
4. Coordinator spawns the worker in an isolated git worktree.

Workers never pick their own work, never touch labels, never merge to the integration branch.

### Worker Isolation

Each worker operates in its own git worktree:

- Worktrees are created from the latest integration branch (configured per repo via `Repo.staging_branch`, typically `dev`) at spawn time.
- Before creating a worktree, the coordinator checks available disk space. If below a configurable threshold (default: 2GB), no new workers are spawned and a warning is posted to the briefing page.
- Workers commit to a task-specific branch (e.g., `worker/{issueNumber}`).
- Workers open a PR when their task is complete.
- Workers never merge to the integration branch — that is the Merge Agent's job.
- Worktrees are cleaned up after the worker completes (or after crash recovery).
- A periodic garbage collection pass (every 10 minutes) removes orphaned worktrees with no active WorkerClaim.

### Merge Agent

The Merge Agent replaces the existing in-memory integration lock from ARCH-AC-CONTROL-PLANE. Runs no longer integrate themselves — the Merge Agent serializes all merges through the MergeQueueEntry table. See the Migration Plan section for details on what this replaces.

The Merge Agent is a **queue consumer**, not an event handler. It polls the MergeQueueEntry table for entries with status `queued`, processes them in priority order, and sleeps when the queue is empty. When a worker opens a PR, the coordinator enqueues a MergeQueueEntry — the Merge Agent picks it up on its next poll.

**Merge order:** The planner's batch defines dependency order. The Merge Agent follows it — if PR A depends on PR B, B merges first even if A finished earlier. If B is not yet complete, A stays `queued` until B is `merged`. PRs outside a batch (immediate dispatch) merge in FIFO order. If a dependency has not been fulfilled within a configurable timeout (default: 30 minutes), the entry is marked `blocked` and flagged on the briefing page.

**Merge strategy — mechanical first, LLM fallback:**

1. Rebase the PR branch onto the latest integration branch.
2. If git auto-resolves: merge with `--no-ff` (atomic single commit).
3. If git conflict and conflict is small (≤3 files, ≤100 conflict lines): spawn an LLM conflict resolution session with the conflicting files, spec context, and a per-session budget cap.
4. If git conflict is large (>3 files or >100 conflict lines) OR LLM resolution fails: mark PR as `needs-human-review`, notify on briefing page. Do not attempt LLM resolution on large conflicts.

**Post-merge validation:**

1. Update MergeQueueEntry phase to `validating`.
2. Run the test suite.
3. If tests pass: update phase to `validated`, mark as `merged`, delete the branch, clean up worktree.
4. If tests fail: revert the merge commit, update phase to `reverted`, mark as `merge-failed`, notify the planner.
5. Planner can re-dispatch a worker to fix the issue or re-plan.

### Planner: Continuous Planning

The planner does not use fixed time-boxed sprints. It groups work into **coherent batches** — sets of related issues that form a deliverable.

**Batch creation:**

A batch is a set of issues with:
- A dependency graph (which issues block which, stored as BatchItem records with dependency edges).
- A "ready set" computed from the graph: issues whose dependencies are all `merged`.
- A target worker count (how many workers the planner wants).
- A budget estimate (based on historical per-phase costs from the CostEvent table).

**Batch state machine:**

```
planning → active → completed
              ↓
           cancelled
```

- `planning` → `active`: When the planner finalizes the batch (dependency graph complete, budget estimated).
- `active` → `completed`: When all issues in the batch have WorkerClaims with status `completed` and all MergeQueueEntries are `merged`.
- `active` → `cancelled`: When the operator cancels via dashboard/terminal OR the planner determines the batch is no longer viable. Cancellation behavior: no new workers are dispatched for this batch. In-flight workers continue to completion (they are not killed). Their PRs still merge normally.
- Only one batch can be `active` at a time. A new higher-priority batch cancels the current one (in-flight workers continue).

**Grouping logic:** Issues sharing an L1 parent, touching the same subsystem, or with explicit dependencies form a natural batch. Independent work (single bug fix, standalone spec) dispatches immediately via the immediate dispatch queue without waiting for a batch.

**Batch creation triggers:**
- Current batch completes.
- New high-priority work arrives (interrupt — current batch cancelled, new batch created).
- A worker gets stuck or blocked (re-plan around it).

**Continuous monitoring — three reaction levels:**

1. **No impact** — Incoming event (new issue, review finding) is unrelated to in-flight work. Queue it for the next batch or dispatch immediately if independent.
2. **Related** — Event touches the same subsystem as in-flight work. Planner decides: absorb into the current worker's scope (if the worker hasn't progressed far) or create a follow-up task.
3. **Invalidating** — Event reveals the in-flight approach is wrong (e.g., a review finding shows the spec has a flaw). Planner pauses the affected worker, re-plans the batch.

Level 2 vs 3 is an LLM judgment call — the planner reads the incoming event, the in-flight work context, and the spec chain to decide.

**Dependencies:**

The planner reads two sources of dependency information:
- **Spec chain** (traceability.yml) — L1 before L2, L2 before L3, L3 before implementation. Cross-cutting specs that reference multiple domains are ordered before domain-specific ones.
- **Explicit dependencies** — `blocked-by: #NNN` in issue metadata or GitHub issue body references. The planner or PO sets these when creating issues.

### PO Agent

The PO Agent is the creative, product-thinking role. It does not write specs directly — it produces **Proposals** (structured feature suggestions stored in Supabase and displayed on the briefing page).

**Inputs:**
- Codebase state (what exists, what's incomplete)
- Existing specs and traceability (what's planned)
- Review findings and recurring issues (what's painful)
- Operator's inbox (ideas submitted via dashboard or terminal)
- System health (briefing data — what's working, what's failing)

**Outputs:**
- Proposals displayed in the "Proposed" section of the briefing page.
- Each proposal includes: title, rationale, estimated scope, and links to related specs/issues.

**Approval flow:** When the operator approves a Proposal, the system creates a GitHub Issue with `feature-pipeline` + `l1-draft` labels and stores the created issue number on the Proposal. The existing pipeline handles L1 spec generation through the normal spec chain. The PO's role is ideation and prioritization, not spec authorship.

**Guardrails:** The PO must never auto-approve its own proposals. Proposals expire if not acted on within a configurable window (default: 30 days). Inbox triggers are debounced — the PO processes accumulated inbox items at most once per `po_interval`, not on every submission.

**Schedule:** Runs periodically (configurable via `GlobalSettings.po_interval`). Also triggered (debounced) when the operator submits an idea to the PO's inbox.

### Operator Interfaces

The operator interacts with the system through three surfaces:

**Dashboard (web) — primary visual interface:**
- Briefing page with sections: Active Now, Needs Attention, Up Next, **Proposed** (PO outbox), Activity Feed.
- Kanban board for PO interaction: approve, reject, reprioritize proposals. Submit new ideas.
- Existing dashboard features (repos, runs, cost, team) unchanged.

**Claude Code terminal (any directory) — conversational interface:**
- A PO skill enables natural conversation: "I want a feature that does X" → PO refines, creates draft.
- An MCP server exposes runforge operations as tools:
  - `list_proposals` — PO's outbox (pending approval).
  - `submit_idea` — write to PO's inbox (operator → PO).
  - `approve_proposal` / `reject_proposal` — act on a proposal.
  - `get_briefing` — current system status summary.
  - `get_active_work` — what workers are currently doing.
  - `get_batch_plan` — planner's current batch with dependency graph.
  - `pause_daemon` / `resume_daemon` — pause/resume all work.
  - `cancel_batch` — cancel the active batch.
  - `reprioritize_issue` — move an issue up/down in the planner's queue.
- MCP server API contract (schemas, auth, error handling) is deferred to the L2 spec (ARCH-AC-COORDINATION).

**GitHub — detail view:**
- Linked from dashboard and terminal output.
- Used for: reading diffs, PR comments, full spec files, issue history.
- Not the daily driver — the operator works through the dashboard and terminal.

## Data Model

New entities (stored in Supabase):

**Proposal** represents a PO-generated feature suggestion awaiting operator decision. It contains: a unique identifier, a title, a rationale (why this adds value), an estimated scope (`small`, `medium`, `large`), a status (`proposed`, `approved`, `rejected`, `deferred`), links to related specs/issues, the approved issue number (set when operator approves and a GitHub Issue is created, null otherwise), the approving user reference, the operator's decision notes (null until acted on), an expiry timestamp, and timestamps for creation and decision.

**Batch** represents a planner-created work package. It contains: a unique identifier, a status (`planning`, `active`, `completed`, `cancelled`), a target worker count, a budget estimate, and timestamps for creation, start, and completion. Only one batch can be `active` at a time.

**BatchItem** represents a single issue within a batch. It contains: a unique identifier, a reference to the batch, the issue number, a status (`pending`, `in_progress`, `completed`, `skipped`), and a list of dependency edges (references to other BatchItem IDs that must complete before this item is ready). The "ready set" is computed as items whose dependencies are all `completed`.

**WorkerClaim** represents an active worker assignment. It contains: a unique identifier, a reference to the issue number, an attempt number (starts at 1, incremented on retry), a reference to the batch item (nullable — immediate dispatch has no batch), the worker session ID, the worktree path, a PR number (set when worker opens PR, null before), an agent type (`worker`, `reviewer`, `po`, `planner`), a status (`claimed`, `in_progress`, `pr_opened`, `completed`, `failed`), a failure reason (nullable), and timestamps for creation and last update. A partial unique constraint ensures only one active claim (status in `claimed`, `in_progress`, `pr_opened`) per issue number. Completed and failed claims are retained for history.

**MergeQueueEntry** represents a PR waiting for integration. It contains: a unique identifier, a PR number, a reference to the worker claim, the issue number, the head SHA at enqueue time, a reference to the batch (nullable), a priority (from planner's dependency order, lower = merge first), a merge phase (`queued`, `rebasing`, `merging`, `validating`, `validated`, `reverted`), a status (`queued`, `merging`, `merged`, `failed`, `blocked`, `needs_human`), the merge commit SHA (set after successful merge, null before), the number of merge attempts, the last failure reason (nullable), and timestamps for creation and last update.

**IdeaSubmission** represents an operator-submitted idea to the PO's inbox. It contains: a unique identifier, the submitting user reference, a description (freeform text), a status (`pending`, `processed`), the resulting proposal reference (set when PO produces a proposal from this idea, null otherwise), and a creation timestamp.

Extensions to existing models:

- **GlobalSettings** gains: `max_agents` (hard safety cap, default 10 — replaces the existing `global_concurrency_limit` field), `reviewer_interval` (schedule for reviewer agent), `po_interval` (schedule for PO agent), `planner_timeout` (max seconds to wait for planner decision, default 60).
- **Run** gains: `worker_claim_id` (reference to WorkerClaim, links a run to the worker that produced it). A single WorkerClaim can produce one or more Runs (e.g., a spec-implement task may trigger decomposition into multiple units, each producing a Run).

## Failure Handling

**Worker crashes mid-task:**
1. Daemon detects the worker process exited unexpectedly.
2. WorkerClaim status set to `failed` with reason. Worktree is cleaned up.
3. If the worker had pushed a partial branch, it is deleted.
4. Planner is notified — it decides whether to retry (creates a new WorkerClaim with incremented `attempt_number`) or re-plan (skip and move on).
5. GitHub label reverted to previous state.

**Merge Agent crashes mid-merge:**
1. MergeQueueEntry retains its current `merge_phase` (e.g., `rebasing`, `merging`, `validating`).
2. On restart, the Merge Agent checks for entries with non-terminal phases:
   - Phase `rebasing` or `merging`: check if merge commit SHA exists on the integration branch. If yes, advance to `validating`. If no, reset to `queued` and retry.
   - Phase `validating`: re-run tests to determine pass/fail.
   - Phase `reverted`: mark as `failed`.
3. Recovery is deterministic because each phase has a clear observable outcome (commit exists or doesn't, tests pass or fail).

**Planner crashes:**
1. The active Batch persists in Supabase with its current state.
2. On restart, the Planner reads the active batch and resumes monitoring.
3. In-flight workers continue — they don't depend on the Planner being alive.
4. The Planner re-evaluates the batch state against current WorkerClaims and MergeQueueEntries.

**Daemon restart:**
1. Read all WorkerClaims with status `claimed` or `in_progress`.
2. Check if corresponding worker processes are alive.
3. Stale claims (no process): set to `failed`, clean up worktrees.
4. Active claims (process alive): re-attach monitoring.
5. Resume the active Batch from Supabase state.
6. Merge Agent checks for non-terminal `merge_phase` entries and recovers.
7. Run worktree garbage collection to clean up orphans.

**Worker stuck (exceeds time or budget limit):**
1. Coordinator kills the worker process.
2. WorkerClaim set to `failed` with reason.
3. Planner notified — may retry with higher budget, skip, or re-plan.
4. Flagged on briefing page under "Needs Attention."

**External dependency outages:**
- **Supabase unreachable:** Coordinator stops dispatching new work. In-flight workers continue (they operate on local worktrees). Merge Agent pauses. Daemon retries with exponential backoff. Workers that complete buffer their results (PR opened on GitHub) and the coordinator reconciles when Supabase recovers.
- **GitHub unreachable:** Workers can still commit locally but cannot open PRs. WorkerClaim stays at `in_progress` until GitHub recovers. Coordinator retries label operations with backoff.
- **Model API failure during conflict resolution:** Merge Agent skips LLM resolution, marks entry as `needs_human`. Does not retry model calls — waits for next merge attempt or human intervention.

## Budget & Safety

- **Global max agents:** Hard cap (default 10, configurable in GlobalSettings). The daemon enforces this regardless of planner decisions.
- **Per-repo concurrency:** Enforced from existing `Repo.concurrency_limit`. A single repo cannot consume more agent slots than its configured limit.
- **Per-session budget:** Each worker session has a budget cap (configurable per skill type).
- **Batch budget:** Planner estimates total batch cost from historical per-phase costs in the CostEvent table. If it exceeds the daily budget, the planner posts a warning on the briefing page instead of executing.
- **PO approval gate:** Proposals never auto-execute. The operator must approve.
- **Planner autonomy with override:** The planner executes batches autonomously, but the operator can pause, reprioritize, or cancel at any time via the dashboard or terminal.
- **Disk space guard:** Coordinator checks available disk before creating worktrees. Below threshold (default: 2GB), no new workers spawn.

## Migration Plan

This design introduces changes that supersede parts of the existing architecture:

**Integration lock → Merge Agent:**
- The existing in-memory integration lock (ARCH-AC-CONTROL-PLANE, lines 11-25 of integration.ts) is removed.
- The `integrate` phase in the pipeline FSM is redefined: instead of "acquire lock, rebase, merge to staging," it now means "open a PR and enqueue a MergeQueueEntry." The actual merge is the Merge Agent's responsibility.
- The MergeQueueEntry `merging` status serves as a database-backed lock — only one entry can be in a `merging` phase at a time.

**Branch model:**
- The existing specs use "staging branch" and "production branch" (configurable per repo in `Repo.staging_branch` and `Repo.production_branch`). This design does not change the branch model — the Merge Agent merges to whatever branch is configured as the repo's staging branch.
- References to "dev" throughout this design doc are shorthand for the repo's configured staging branch.

**Validation flow:**
- The existing architecture runs integration review (via Validation Service) before merging to staging. The new model merges first, then validates (tests), and reverts on failure. This is a deliberate change: with multiple agents producing PRs, pre-merge validation on a shared staging branch would serialize all validation and become a bottleneck. Post-merge validation with revert is faster and the revert safety net is acceptable because each merge is a single atomic `--no-ff` commit.

**Affected specs requiring updates:**
- ARCH-AC-CONTROL-PLANE: Remove integration lock, redefine `integrate` phase, add worker pool and coordinator.
- FUNC-AC-PIPELINE: Add scenarios for parallel dispatch, PR-based integration, batch lifecycle.
- ARCH-AC-DASHBOARD: Add new data model entities (Proposal, Batch, BatchItem, WorkerClaim, MergeQueueEntry, IdeaSubmission). Rename `global_concurrency_limit` to `max_agents`.

## Relationship to Existing Specs

This design extends the existing spec chain:

- **FUNC-AC-DASHBOARD** — Extended with PO kanban, "Proposed" briefing section, and MCP server scenarios.
- **ARCH-AC-DASHBOARD** — Extended with Proposal data model and MCP API contract.
- **FUNC-AC-PIPELINE** — Extended with parallel execution, planner role, and merge agent behavior.
- **ARCH-AC-CONTROL-PLANE** — Integration lock replaced by Merge Agent. Worker pool, work claiming, and planner coordination added. Existing worktree isolation patterns reused. See Migration Plan for details.
- **New: FUNC-AC-COORDINATION** — L1 spec for the planner, PO, merge agent, and parallel execution model. Covers: batch creation scenarios, continuous re-planning, dependency ordering, merge conflict resolution, operator override.
- **New: MCP Server** — New component exposing runforge operations for Claude Code terminal access. API contract defined at L2.

## Open Questions

- What model tier should the Planner use? It needs judgment but runs frequently — balance cost vs quality. Suggestion: start with the same model as the classifier (tuned for judgment at moderate cost). Resolve before L2 spec by running cost estimate at expected invocation frequency.
- Should the PO have access to external sources (competitor docs, user forums) or only internal signals?
- Conflict resolution budget: what is the per-session cap for LLM conflict resolution? Suggestion: same as a bug-worker session.
