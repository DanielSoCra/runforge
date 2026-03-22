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
| PO | Proposes features, refines operator ideas, produces Proposals | 1 | 1 | Schedule + operator input |
| Planner | Groups work into batches, orders by dependency, monitors and re-plans | 0 | 1 | Batch complete, new events, stuck workers |

**Execution:**

| Agent | Purpose | Min | Max | Trigger |
|-------|---------|-----|-----|---------|
| Worker | Executes any task (specs, implementation, bug fixes) using appropriate skill | 1 | configurable | Planner dispatches |
| Reviewer | Proactively scans codebase for issues, creates review-finding issues | 1 | 1 | Schedule |

**Infrastructure (outside worker pool):**

| Agent | Purpose | Always | Trigger |
|-------|---------|--------|---------|
| Merge Agent | Integrates PRs in dependency order, runs tests, reverts if broken | 1 | PR opened or updated |

**Worker vs Reviewer:** Both execute tasks, but Workers are reactive (dispatched by the Planner for a specific issue) while the Reviewer is proactive (runs on a schedule, scans the codebase, creates new issues). The Reviewer's min=1 ensures continuous code quality monitoring. Its output (review-finding issues) feeds back into the Planner's queue as potential work for Workers.

### Worker Pool

A shared pool of N worker slots, configured via `GlobalSettings.max_workers`.

- **Global max workers** is a hard safety cap (default: 10). The daemon never spawns more workers than this regardless of planner decisions.
- **Planner decides actual concurrency** per batch — may use 3 workers for a small batch, 8 for a large independent set. The planner's target is a request, not a guarantee.
- **Per-type min** guarantees reserved capacity (Reviewer min=1 ensures continuous code review).
- **Per-type max** prevents starvation (e.g., max workers for a type prevents one type from consuming all slots).
- **Merge Agent runs outside the pool** — it is infrastructure, not a worker. It must never be blocked because all slots are full.

### Concurrency Algorithm

The daemon coordinator evaluates on every tick and on worker completion events:

```
available_slots = GlobalSettings.max_workers - count(active WorkerClaims)

# 1. Ensure per-type minimums are met first
for each agent type with min > 0 and active_count < min:
    if available_slots > 0:
        spawn agent of this type
        available_slots -= 1

# 2. Fill remaining slots from planner's batch
planner_target = min(batch.target_worker_count, available_slots)
for i in 1..planner_target:
    next_issue = batch.next_unblocked_unclaimed_issue()
    if next_issue and type_count < type_max:
        claim and spawn worker for next_issue
```

Per-type max is enforced at spawn time. If spawning would exceed a type's max, skip and try the next issue.

### Work Claiming

The daemon coordinator (single process) assigns all work:

1. Planner decides which issue to dispatch and to which worker type.
2. Coordinator claims the issue atomically in Supabase (INSERT with unique constraint on issue number). No race conditions.
3. Coordinator applies the GitHub label after the claim succeeds. Labels reflect state — they do not drive it. Supabase is the source of truth.
4. Coordinator spawns the worker in an isolated git worktree.

Workers never pick their own work, never touch labels, never merge to dev.

### Worker Isolation

Each worker operates in its own git worktree:

- Worktrees are created from the latest `dev` branch at spawn time.
- Workers commit to a task-specific branch (e.g., `worker/{issueNumber}`).
- Workers open a PR when their task is complete.
- Workers never merge to `dev` — that is the Merge Agent's job.
- Worktrees are cleaned up after the worker completes (or after crash recovery).

### Merge Agent

The Merge Agent replaces the existing in-memory integration lock from ARCH-AC-CONTROL-PLANE. Runs no longer integrate themselves — the Merge Agent serializes all merges to dev through the MergeQueueEntry table. The `merging` status serves as a database-backed lock (crash-safe, unlike the in-memory lock).

**Merge order:** The planner's batch defines dependency order. The Merge Agent follows it — if PR A depends on PR B, B merges first even if A finished earlier. PRs outside a batch (immediate dispatch) merge in FIFO order.

**Merge strategy — mechanical first, LLM fallback:**

1. Rebase the PR branch onto latest `dev`.
2. If git auto-resolves: merge with `--no-ff` (atomic single commit).
3. If git conflict: spawn an LLM conflict resolution session with the conflicting files and spec context.
4. If LLM resolution fails: mark PR as `needs-human-review`, notify on briefing page.

**Post-merge validation:**

1. After every merge, run the test suite.
2. If tests pass: merge is final, delete the branch, clean up worktree.
3. If tests fail: revert the merge commit, mark PR as `merge-failed`, notify the planner.
4. Planner can re-dispatch a worker to fix the issue or re-plan.

### Planner: Continuous Planning

The planner does not use fixed time-boxed sprints. It groups work into **coherent batches** — sets of related issues that form a deliverable.

**Batch creation:**

A batch is a set of issues with:
- A dependency order (which issues must complete before others can start).
- A parallelism map (which issues can execute simultaneously).
- A target worker count (how many workers the planner wants).
- A budget estimate (based on historical per-phase costs from the CostEvent table).

**Grouping logic:** Issues sharing an L1 parent, touching the same subsystem, or with explicit dependencies form a natural batch. Independent work (single bug fix, standalone spec) dispatches immediately without waiting for a batch.

**Batch creation triggers:**
- Current batch completes.
- New high-priority work arrives (interrupt).
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

**Approval flow:** When the operator approves a Proposal, the system creates a GitHub Issue with `feature-pipeline` + `l1-draft` labels. The existing pipeline handles L1 spec generation through the normal spec chain. The PO's role is ideation and prioritization, not spec authorship.

**Schedule:** Runs periodically (configurable via `GlobalSettings.po_interval`). Also triggered when the operator submits an idea to the PO's inbox.

### Operator Interfaces

The operator interacts with the system through three surfaces:

**Dashboard (web) — primary visual interface:**
- Briefing page with sections: Active Now, Needs Attention, Up Next, **Proposed** (PO outbox), Activity Feed.
- Kanban board for PO interaction: approve, reject, reprioritize proposals. Submit new ideas.
- Existing dashboard features (repos, runs, cost, team) unchanged.

**Claude Code terminal (any directory) — conversational interface:**
- A PO skill enables natural conversation: "I want a feature that does X" → PO refines, creates draft.
- An MCP server exposes auto-claude operations as tools:
  - `list_proposals` — PO's outbox (pending approval).
  - `submit_idea` — write to PO's inbox (operator → PO).
  - `approve_proposal` / `reject_proposal` — act on a proposal.
  - `get_briefing` — current system status summary.
  - `get_active_work` — what workers are currently doing.
  - `get_batch_plan` — planner's current batch with dependency graph.
  - `pause_daemon` / `resume_daemon` — pause/resume all work.
  - `cancel_batch` — cancel the active batch.
  - `reprioritize_issue` — move an issue up/down in the planner's queue.

**GitHub — detail view:**
- Linked from dashboard and terminal output.
- Used for: reading diffs, PR comments, full spec files, issue history.
- Not the daily driver — the operator works through the dashboard and terminal.

## Data Model

New entities (stored in Supabase):

**Proposal** represents a PO-generated feature suggestion awaiting operator decision. It contains: a unique identifier, a title, a rationale (why this adds value), an estimated scope (`small`, `medium`, `large`), a status (`proposed`, `approved`, `rejected`, `deferred`), links to related specs/issues, the operator's decision notes (null until acted on), and timestamps for creation and decision.

**Batch** represents a planner-created work package. It contains: a unique identifier, a status (`planning`, `active`, `completed`, `cancelled`), an ordered list of issue references with their dependency relationships, a parallelism map (which issues can execute concurrently), a target worker count, a budget estimate, and timestamps for creation, start, and completion.

**WorkerClaim** represents an active worker assignment. It contains: a unique identifier, a reference to the issue number (unique constraint — one claim per issue), a reference to the batch (nullable — immediate dispatch has no batch), the worker session ID, the worktree path, a status (`claimed`, `in_progress`, `pr_opened`, `completed`, `failed`), a failure reason (nullable), and timestamps for creation and last update.

**MergeQueueEntry** represents a PR waiting for integration. It contains: a unique identifier, a PR number, a reference to the batch (nullable), a priority (from planner's dependency order), a status (`queued`, `merging`, `merged`, `failed`, `needs_human`), the number of merge attempts, the last failure reason (nullable), and timestamps for creation and last update.

Extensions to existing models:

- **GlobalSettings** gains: `max_workers` (hard safety cap, default 10), `reviewer_interval` (schedule for reviewer agent), `po_interval` (schedule for PO agent).
- **Run** gains: `worker_claim_id` (reference to WorkerClaim, links a run to the worker that produced it).

## Failure Handling

**Worker crashes mid-task:**
1. Daemon detects the worker process exited unexpectedly.
2. WorkerClaim status set to `failed`. Worktree is cleaned up.
3. If the worker had pushed a partial branch, it is deleted.
4. Planner is notified — it decides whether to retry (re-dispatch same issue) or re-plan (skip and move on).
5. GitHub label reverted to previous state.

**Merge Agent crashes mid-merge:**
1. MergeQueueEntry status remains `merging` (stale).
2. On restart, the Merge Agent checks for stale `merging` entries.
3. If the merge commit exists on dev, mark as `merged`. If not, reset to `queued` and retry.
4. The Merge Agent uses `--no-ff` merges — each merge is a single atomic commit, so partial merges cannot exist.

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
6. Merge Agent checks for stale `merging` entries and recovers.

**Worker stuck (exceeds time or budget limit):**
1. Coordinator kills the worker process.
2. WorkerClaim set to `failed` with reason.
3. Planner notified — may retry with higher budget, skip, or re-plan.
4. Flagged on briefing page under "Needs Attention."

## Budget & Safety

- **Global max workers:** Hard cap (default 10, configurable in GlobalSettings). The daemon enforces this regardless of planner decisions.
- **Per-session budget:** Each worker session has a budget cap (configurable per skill type).
- **Batch budget:** Planner estimates total batch cost from historical per-phase costs in the CostEvent table. If it exceeds the daily budget, the planner posts a warning on the briefing page instead of executing.
- **PO approval gate:** Proposals never auto-execute. The operator must approve.
- **Planner autonomy with override:** The planner executes batches autonomously, but the operator can pause, reprioritize, or cancel at any time via the dashboard or terminal.

## Relationship to Existing Specs

This design extends the existing spec chain:

- **FUNC-AC-DASHBOARD** — Extended with PO kanban, "Proposed" briefing section, and MCP server scenarios.
- **ARCH-AC-DASHBOARD** — Extended with Proposal data model and MCP API contract.
- **FUNC-AC-PIPELINE** — Extended with parallel execution, planner role, and merge agent behavior.
- **ARCH-AC-CONTROL-PLANE** — The existing in-memory integration lock is replaced by the Merge Agent with database-backed MergeQueueEntry. Worker pool, work claiming, and planner coordination are new additions. Existing worktree isolation patterns are reused.
- **New: FUNC-AC-COORDINATION** — L1 spec for the planner, PO, merge agent, and parallel execution model. Covers: batch creation scenarios, continuous re-planning, dependency ordering, merge conflict resolution, operator override.
- **New: MCP Server** — New component exposing auto-claude operations for Claude Code terminal access.

## Open Questions

- What model tier should the Planner use? It needs judgment but runs frequently — balance cost vs quality. Suggestion: start with the same model as the classifier (tuned for judgment at moderate cost).
- Should the PO have access to external sources (competitor docs, user forums) or only internal signals?
- How long should the Merge Agent wait for a dependency before flagging it as blocked? Suggestion: configurable timeout, default 30 minutes.
