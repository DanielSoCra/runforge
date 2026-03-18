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

- **Operator** — receives escalations when automated implementation cannot proceed safely
- **Spec Author** — authored the specifications that govern the implementation

## Behavior

**Scenario: Decomposition into parallel units**
- Given a work request with referenced specifications
- When the system analyzes the scope
- Then it produces a work plan broken into independently executable units, grouped so unrelated work can proceed in parallel

**Scenario: Unit context isolation**
- Given a unit assignment
- When implementation begins
- Then the assigned unit receives the governing context, task context, and known pitfalls it needs up front rather than reconstructing that context on its own

**Scenario: Verification-first implementation**
- Given an implementation unit has been assigned
- When work begins
- Then it begins by establishing or selecting verification that can fail before the change and pass after it; for bug fixes this verification is a regression test

**Scenario: Local verification before handoff**
- Given a Worker has written implementation changes
- When the Worker prepares to commit
- Then it runs local verification checks (automated checks, formatting) and fixes issues before committing — so the review phase receives already-clean work rather than catching basic hygiene issues

**Scenario: Graduated exit status**
- Given an implementation unit has finished
- When it reports its result
- Then it reports whether the work completed cleanly, completed with concerns, is blocked, or needs more context — each causing a distinct follow-up path

**Scenario: Completed-with-concerns routing**
- Given an implementation unit finishes with concerns
- When the system processes this status
- Then it proceeds but schedules additional review rounds

**Scenario: Blocked routing**
- Given an implementation unit cannot proceed safely
- When the system processes this status
- Then it escalates to the Operator without consuming retry attempts

**Scenario: Needs-more-context routing**
- Given an implementation unit cannot proceed with the context it has
- When the system processes this status
- Then it re-runs the unit with additional spec content from the layer above

**Scenario: Parallel batch execution**
- Given a batch of units with no output overlap
- When the system executes the batch
- Then all units in the batch can proceed in parallel without interfering with one another

**Scenario: Sequential batch merging**
- Given a batch of units has completed
- When the system merges results
- Then the completed work is combined and verified before dependent work continues

**Scenario: Merge conflict resolution**
- Given a merge conflict occurs between units
- When the system detects the conflict
- Then it resolves the conflict in favor of the governing specification rather than either conflicting change set

**Scenario: Simple work requests**
- Given a work request classified as "simple"
- When the system begins implementation
- Then it skips decomposition and executes as a single unit

**Scenario: Spec divergence**
- Given an existing implementation that does not match the governing spec
- When the system encounters this divergence during implementation
- Then it treats this as a reconciliation task, not an error — aligning the implementation to the spec

**Scenario: Context size heuristic**
- Given a unit whose scope exceeds what can be handled reliably as one piece of work
- When the system evaluates the unit
- Then it decomposes the unit further until each sub-unit can be handled reliably

**Scenario: Context capacity during implementation**
- Given a Worker's session approaches its reasoning capacity during a long implementation
- When the system detects capacity is nearing limits
- Then it compacts older context while preserving the current task state, so the Worker can continue without losing critical working information

## Success Criteria

- Multi-unit features are implemented in parallel without output conflicts
- Implementation units produce changes backed by verification appropriate to the change, and that verification passes before the unit is complete
- Merge conflicts are resolved automatically in favor of spec intent
- Implementation work receives the governing context it needs without reconstructing it from raw specification artifacts

## Constraints

- Implementation units work independently — they cannot see or affect each other's output while executing
- Governing context is prepared before implementation begins
- If a unit's scope cannot be handled reliably as one piece of work, it must be decomposed further
- Each unit includes a clear verification method that confirms the intended outcome
