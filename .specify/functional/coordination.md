---
id: FUNC-AC-COORDINATION
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-COORDINATION — Parallel Agent Coordination

## Problem Statement

An autonomous development system that processes work serially wastes capacity when multiple independent work streams exist simultaneously. Running work in parallel requires coordination to prevent conflicts, duplicated effort, and wasted budget. The system needs a planning layer that orders work by dependency, a merge layer that integrates completed work safely, and an interface that lets the operator direct product evolution without managing individual work items.

## Relationship to Other Specs

This spec extends FUNC-AC-PIPELINE for multi-issue orchestration. FUNC-AC-PIPELINE defines the lifecycle of a single work request (detect → classify → implement → review → deploy). This spec defines how multiple work requests are batched, prioritized, and integrated, plus the product ownership capability where the system proposes new work.

## Actors

- **Operator** — directs product evolution, approves feature proposals, monitors system status, overrides system decisions when needed

## Behavior

### Product Ownership

**Scenario: System proposes a feature**
- Given the system periodically analyzes the codebase, specifications, findings, and system health
- When it identifies a potential improvement or new feature
- Then it produces a proposal with a title, rationale, estimated scope, and links to related work

**Scenario: Operator approves a proposal**
- Given the system has produced a proposal
- When the operator approves it
- Then a work request is created and enters the pipeline for specification and implementation

**Scenario: Operator submits an idea**
- Given the operator has an idea for a feature or improvement
- When they submit it through the dashboard or terminal
- Then the system receives it and refines it into a proposal on its next scheduled cycle

**Scenario: Proposal expiry**
- Given a proposal has been pending for longer than a configurable window
- When the expiry time is reached
- Then the proposal is marked as expired and removed from the active queue

**Scenario: Proposal guardrails**
- Given the system produces proposals
- When a proposal is created
- Then it always requires operator approval — the system never acts on its own proposals autonomously

### Batch Planning

**Scenario: System creates a batch from related work**
- Given multiple related issues are ready for work
- When the system analyzes their dependencies and relationships
- Then it creates a batch with a dependency graph, parallelism map, target concurrency, and budget estimate

**Scenario: Independent work dispatches immediately**
- Given an issue is ready for work and has no dependencies on other pending issues
- When the system evaluates it
- Then it dispatches the issue immediately without waiting to form a batch

**Scenario: Batch completes**
- Given all issues in a batch have been completed and integrated
- When the last issue is merged
- Then the batch is marked complete and the system creates the next batch from remaining work

**Scenario: Higher-priority work arrives**
- Given a batch is currently active
- When new work arrives that the system judges to be higher priority
- Then the system cancels the current batch and creates a new one — in-flight work continues to completion but no new work is dispatched for the cancelled batch

**Scenario: Work item gets stuck**
- Given a work item in a batch exceeds its time or budget limit
- When the system detects the failure
- Then it decides whether to retry the issue, skip it, or re-plan the batch around the failure

### Continuous Re-Planning

**Scenario: Unrelated event during active batch**
- Given a batch is active and a new event occurs (new issue, review finding)
- When the system evaluates the event against in-flight work
- Then it determines the event is unrelated and queues it for the next batch or dispatches immediately

**Scenario: Related event during active batch**
- Given a batch is active and a finding touches the same area as in-flight work
- When the system evaluates the relationship
- Then it decides whether to absorb the finding into the current work scope or create a follow-up task

**Scenario: Invalidating event during active batch**
- Given a batch is active and a finding reveals the in-flight approach is flawed
- When the system evaluates the impact
- Then it pauses the affected work and re-plans the batch

### Concurrency Management

**Scenario: System respects global concurrency cap**
- Given a configurable maximum number of concurrent workers
- When the system evaluates whether to start new work
- Then it never exceeds the global cap regardless of planner requests

**Scenario: Per-type minimums are enforced**
- Given agent types have configurable minimum counts
- When the system evaluates the pool
- Then it ensures each type's minimum is met before allocating remaining capacity to planned work

**Scenario: Per-repository concurrency is enforced**
- Given a repository has a configured concurrency limit
- When work for that repository is dispatched
- Then the system does not exceed the per-repository limit

**Scenario: Resource guard**
- Given each concurrent worker requires local resources
- When available resources fall below a configurable threshold
- Then no new workers are started and a warning is posted to the operator

### Work Claiming

**Scenario: Exclusive work claiming**
- Given the system has selected an issue for dispatch
- When it claims the issue
- Then the claim is exclusive — no two workers can work on the same issue simultaneously

**Scenario: Workers are isolated**
- Given work has been dispatched
- When a worker executes its task
- Then it operates in isolation from other workers and never integrates its own changes into the shared codebase

### Merge Coordination

**Scenario: Automatic merge succeeds**
- Given a worker has completed its task
- When the system processes its output for integration
- Then it integrates the changes into the shared codebase if no conflicts exist

**Scenario: Small conflict is resolved automatically**
- Given completed work has conflicts with the current codebase that are small in scope
- When the system detects the conflict
- Then it attempts automatic resolution using the conflicting files and specification context

**Scenario: Large conflict requires human review**
- Given completed work has conflicts that are large in scope or cannot be resolved automatically
- When the system evaluates the conflict
- Then it flags the work for human review and notifies the operator

**Scenario: Integration validation failure**
- Given the system has integrated completed work
- When validation fails after integration
- Then the system reverts the integration and notifies the planner for re-dispatch or re-planning

**Scenario: Dependency-ordered integration**
- Given work item A depends on work item B
- When both are complete
- Then B is integrated first, even if A completed earlier

**Scenario: Dependency timeout**
- Given work is waiting for a dependency that has not been fulfilled
- When a configurable timeout is reached
- Then the system marks the item as blocked and flags it for the operator

### Operator Interface

**Scenario: Operator views proposals on briefing page**
- Given the system has produced proposals
- When the operator views the briefing page
- Then they see a "Proposed" section with each proposal's title, rationale, scope, and approve/reject actions

**Scenario: Operator interacts via terminal**
- Given the system exposes operations through a terminal interface
- When the operator uses the terminal from any working directory
- Then they can list proposals, submit ideas, approve/reject proposals, view system status, pause/resume work, and cancel batches

**Scenario: Operator overrides system decisions**
- Given the system is executing a batch
- When the operator pauses, reprioritizes, or cancels work
- Then the system responds immediately — in-flight work continues but no new work is dispatched

### Failure Recovery

**Scenario: Worker crashes**
- Given a worker process exits unexpectedly
- When the system detects the crash
- Then the claim is released, resources are cleaned up, and the system decides on retry or skip

**Scenario: Integration service crashes mid-operation**
- Given the integration service exits during an operation
- When the system restarts it
- Then it recovers deterministically without corrupting the shared codebase

**Scenario: System restarts**
- Given the system process restarts
- When it initializes
- Then it recovers all active claims, reattaches to running workers, resumes the active batch, and cleans up orphaned resources

**Scenario: External dependency outage**
- Given an external dependency (database, source control, model provider) is unavailable
- When the system detects the outage
- Then in-flight work continues where possible, new dispatches pause, and the system retries with backoff until the service recovers

## Success Criteria

- Multiple work items execute simultaneously without integration conflicts
- Work is ordered by dependency — dependent changes integrate in the correct order
- The operator directs product evolution through proposals and approvals, not by managing individual work items
- The system re-plans when new information arrives, rather than executing a stale plan
- Budget limits prevent runaway cost across all concurrent work
- The system recovers from crashes without losing work or corrupting the shared codebase

## Constraints

- The operator must approve all proposals before they enter the pipeline — no autonomous feature creation
- Only the integration service merges to the shared codebase — workers never integrate directly
- The database is the source of truth for work claims and integration state
- A single system process coordinates all workers — no distributed execution
- The global concurrency cap is a hard safety limit that cannot be exceeded
