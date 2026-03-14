---
id: FUNC-AC-IMPLEMENTATION
type: functional
domain: auto-claude
status: draft
version: 1
layer: 1
---

# FUNC-AC-IMPLEMENTATION — Autonomous Spec Implementation

## Problem Statement

Implementing specifications requires decomposing them into parallelizable units, assigning each unit enough context to work in isolation, and merging results without conflicts. When done manually, this decomposition is the most time-consuming part of the workflow. Automating it enables walk-away execution of complex multi-artifact features.

## Actors

- **Coordinator** — decomposes work requests into parallelizable units (intelligent, not human)
- **Worker** — implements a single unit from pre-loaded context (intelligent, not human)
- **Spec Author** — authored the specifications that govern the implementation

## Behavior

**Scenario: Decomposition into parallel units**
- Given a work request with referenced specifications
- When the Coordinator analyzes the scope
- Then it produces a structured task graph of units grouped into parallel batches, where units within a batch have no output-level overlap

**Scenario: Unit context isolation**
- Given a unit assignment
- When the Worker receives its task
- Then all spec content, unit context, and known pitfalls are pre-loaded into the Worker's context — the Worker never accesses specification artifacts directly

**Scenario: Test-driven implementation**
- Given a Worker has received its assignment
- When the Worker begins implementation
- Then it follows a strict test-driven protocol: write a failing test, verify it fails, implement the solution, verify the test passes, refactor if needed, then commit

**Scenario: Graduated exit status**
- Given a Worker has finished its assignment
- When it reports its result
- Then it exits with one of: completed, completed-with-concerns, blocked, or needs-more-context — each triggering different system behavior

**Scenario: Completed-with-concerns routing**
- Given a Worker exits with "completed-with-concerns"
- When the system processes this status
- Then it proceeds but schedules additional review rounds

**Scenario: Blocked routing**
- Given a Worker exits with "blocked"
- When the system processes this status
- Then it escalates to the Operator without consuming retry attempts

**Scenario: Needs-more-context routing**
- Given a Worker exits with "needs-more-context"
- When the system processes this status
- Then it re-runs the unit with additional spec content from the layer above

**Scenario: Parallel batch execution**
- Given a batch of units with no output overlap
- When the system executes the batch
- Then all units in the batch run simultaneously in isolated workspaces

**Scenario: Sequential batch merging**
- Given a batch of units has completed
- When the system merges results
- Then each unit merges into the unified branch, and post-integration verification runs before the next batch begins

**Scenario: Merge conflict resolution**
- Given a merge conflict occurs between units
- When the system detects the conflict
- Then it spawns a specialized resolution step that favors spec intent over either branch

**Scenario: Simple work requests**
- Given a work request classified as "simple"
- When the system begins implementation
- Then it skips decomposition and executes as a single unit

**Scenario: Spec divergence**
- Given an existing implementation that does not match the governing spec
- When the Worker encounters this divergence
- Then it treats this as a reconciliation task, not an error — aligning the implementation to the spec

**Scenario: Context size heuristic**
- Given a unit whose scope exceeds a single reasoning context
- When the Coordinator evaluates the unit
- Then it decomposes the unit further until each sub-unit fits in one context

## Success Criteria

- Multi-unit features are implemented in parallel without output conflicts
- Workers produce test-driven implementations that pass their verification commands
- Merge conflicts are resolved automatically in favor of spec intent
- Workers never access specification artifacts directly — all context is pre-loaded

## Constraints

- Workers operate in complete isolation — they cannot see or affect each other's work
- All spec content is pre-loaded by the system — Workers never browse the specification repository
- If a unit's scope doesn't fit in a single reasoning context, it must be decomposed further
- Each unit includes a verification command that the Worker uses to confirm its implementation
