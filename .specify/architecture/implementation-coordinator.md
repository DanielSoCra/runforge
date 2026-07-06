---
id: ARCH-AC-IMPLEMENTATION
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-IMPLEMENTATION
---

# ARCH-AC-IMPLEMENTATION — Implementation Coordinator

## Overview

The Implementation Coordinator decomposes work requests into parallel units, manages their concurrent execution across isolated workspaces, and integrates results into a unified branch. It handles the full lifecycle from task graph creation through batch execution, merge sequencing, conflict resolution, and post-integration verification.

## Data Model

**TaskGraph** represents the decomposition of a work request. It contains: the work request identifier (issue number), the feature branch name, and an ordered array of units.

**Unit** represents a single parallelizable work assignment. It contains: a unique identifier, a human-readable title, an array of governing spec identifiers, pre-loaded spec content (the full text of each spec, assembled by the coordinator), an array of expected artifact locations, an array of dependency identifiers (other units that must complete first, used for batch ordering), a batch number (units in the same batch run concurrently), a verification command (used by the worker to confirm its implementation), assembled context (a text block containing the unit description, spec content, and any additional context the worker needs), and an estimated change size (used for pre-flight scope validation).

**UnitState** tracks execution status for a single unit. It contains: the unit identifier, a status (pending, running, completed, completed-with-concerns, blocked, needs-context, failed), the workspace path, the current attempt number, an error description if failed, and an optional handoff record (a HandoffRecord from the previous attempt, as defined in ARCH-AC-HANDOFF — absent when the session completed cleanly or produced no handoff output).

**MergeSequence** tracks the order in which completed units merge into the feature branch. It contains: the feature branch name, an ordered list of unit identifiers to merge, and the current position in the sequence.

## API Contract

**Decompose** — Called by the Daemon Control Plane. Request: work request body, referenced spec identifiers, spec content (assembled in understanding order: business context first, then architecture, then patterns), traceability map. Response: a validated TaskGraph. The coordinator assembles a prompt containing all inputs, spawns a one-shot session via Session Runtime, and validates the structured output against the task graph schema. On validation failure, retry once before escalating.

**Implement** — Called by the Daemon Control Plane. Request: a TaskGraph and the current checkpoint position (for crash resumption). Response: success (all units merged and verified), failure (with details), or escalation (blocked unit or unresolvable conflict).

The implement operation proceeds as follows:

1. Receive the feature branch name (created by the Daemon Control Plane before calling this operation).
2. For each batch (sequentially, starting from the checkpoint batch):
   a. For each unit in the batch (concurrently, with a stagger delay between starts):
      - Create an isolated workspace branched from the feature branch.
      - Assemble the unit's context: pre-loaded spec content, unit assignment, known pitfalls from Knowledge Service.
      - Spawn a worker session via Session Runtime.
      - Monitor the worker's exit status.
   b. After all units in the batch complete: merge each unit's workspace into the feature branch in sequence.
   c. Run post-integration verification on the feature branch.
   d. Save checkpoint (batch number and completed units).
   e. Proceed to next batch.

**Exit status routing:**

- Completed: success. Unit workspace merges normally.
- Completed-with-concerns: success, but flag the run for additional review rounds. Unit workspace merges normally.
- Blocked: escalate to the operator without consuming a retry attempt. Do not merge.
- Needs-more-context: re-run the unit with additional spec content from the parent layer. Consumes one retry attempt.

**Fix** — Called by the Validation Service when review gates or tests fail. Request: findings (structured issues from review or test failure), affected artifact locations, governing specs. Response: fix result (success/failure, changes made).

The fix operation proceeds:
1. Create a single-unit workspace from the target branch.
2. Assemble context with the findings, governing spec content, and affected artifact locations.
3. Spawn a worker session via Session Runtime using a regression-test-first protocol.
4. Merge the fix into the target branch.

## System Boundaries

- Implementation Coordinator OWNS: task graph, unit assignments, unit state tracking, merge sequencing, workspace-to-branch integration.
- Implementation Coordinator CALLS: Session Runtime (to spawn Coordinator sessions for decomposition, Worker sessions for implementation, and Conflict Resolver sessions for merge conflicts), Knowledge Service (to retrieve matching pitfalls for each unit's expected artifact locations before context assembly).
- Daemon Control Plane CALLS Implementation Coordinator for: the decompose phase and the implement phase. Validation Service CALLS Implementation Coordinator for: the fix operation (when review gates or tests fail).
- The Daemon Control Plane creates and deletes feature branches. The Implementation Coordinator receives the feature branch name and performs all merges into it, but does not create or delete branches.

## Event Flows

**Decomposition flow:**
1. Receive work request body, spec content, and traceability map from the Daemon Control Plane.
2. Assemble the coordinator prompt: work request summary, full spec content (in understanding order: business context first, then architecture, then patterns — this order helps the Coordinator understand the scope before seeing implementation details), traceability map, and instructions for producing a task graph.
3. Spawn a one-shot coordinator session via Session Runtime with structured output validation.
4. Receive the task graph. Validate: all unit identifiers are unique, batch numbers are sequential, dependency references are valid, no unit depends on a unit in the same or later batch.
5. Evaluate each unit's scope against context capacity. If a unit's specification content, expected artifacts, and surrounding context exceed a single reasoning context, recursively decompose it into smaller sub-units until each fits within one context.
6. Save the task graph.
7. Return the validated task graph to the Daemon Control Plane. The Control Plane creates the feature branch before calling the implement operation.

**Implementation flow (per batch):**
1. Read the task graph and checkpoint. Skip completed batches.
2. For the current batch, spawn units concurrently with stagger delay:
   a. Create an isolated workspace from the feature branch (with structural exclusions applied by Session Runtime).
   b. Query Knowledge Service for pitfalls matching the unit's expected artifact locations.
   c. Assemble the unit prompt: spec content in implementation order (patterns first, then architecture, then business context — the reverse of understanding order, so the Worker sees actionable patterns before abstract intent), unit context, pitfalls, verification command. All content is pre-loaded; Workers never reference spec artifacts by path.
   d. Spawn a worker session via Session Runtime.
3. As each unit completes, record its exit status and cost. Measure the change size (lines changed) of the unit's workspace diff.
4. After all units in the batch finish: process exit statuses (route blocked/needs-context as needed). For any unit whose change size exceeds the configured threshold (default: 300 lines changed): flag the unit for re-decomposition. The unit's workspace is not merged; instead, the unit is split into smaller sub-units and re-executed in a subsequent batch.
5. For successful units: merge each workspace into the feature branch sequentially. If a merge conflict occurs, spawn a Conflict Resolver session.
6. Run post-integration verification on the feature branch. If verification fails, retry the entire batch (up to max retries).
7. Save checkpoint. Proceed to next batch.

Worker sessions follow a test-driven execution protocol: write a failing verification, confirm it fails, implement the solution, confirm the verification passes, refactor if needed, then run local verification checks (automated checks, formatting) and fix any issues before committing. This "shift left" approach ensures the review phase receives already-clean work rather than catching basic hygiene issues. The protocol is enforced via the worker's prompt template.

**Conflict resolution flow:**
1. Detect merge conflict during workspace-to-branch integration.
2. Assemble conflict context: the conflicting diff, the governing specs for both units, and the spec intent.
3. Spawn a Conflict Resolver session via Session Runtime.
4. The resolver produces a merged result favoring spec intent.
5. Apply the resolution and continue the merge sequence.

**Simple work request path:**
1. The Daemon Control Plane indicates the work request is classified as simple.
2. Skip decomposition entirely. Create a single-unit task graph with one batch containing one unit.
3. Proceed with the standard implementation flow.

## Error Handling

**Worker timeout:** The Session Runtime terminates the worker process after the configured timeout. The unit is marked as failed and retried (up to max attempts per unit). The workspace is cleaned up.

**Merge conflict:** Spawn a Conflict Resolver session. If the resolver cannot produce a clean merge (its session times out or produces invalid output), mark the batch as failed and retry.

**Post-integration verification failure:** Retry the entire batch. If the batch fails verification after max retries, escalate to stuck.

**Unit scope too large:** If a worker exits with "needs-more-context" and re-running with parent-layer spec content does not resolve it, the unit may need further decomposition. Escalate to the operator as stuck.

**Coordinator produces invalid task graph:** Retry the decomposition session once. If the second attempt also produces invalid output, escalate to stuck.

**Spec divergence:** When a worker encounters existing implementation that diverges from the governing specification, it treats the divergence as a reconciliation task — aligning the implementation to match the spec rather than treating it as an error condition.

**Batch partially complete on crash:** Resume from the checkpoint. Units already merged are skipped. Units not yet started are re-run. Units that were running at crash time are re-run (their workspaces may be in an inconsistent state and are recreated).
