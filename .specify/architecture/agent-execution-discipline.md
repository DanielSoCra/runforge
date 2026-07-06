---
id: ARCH-AC-AGENT-DISCIPLINE
type: architecture
domain: runforge
status: draft
version: 1
layer: 2
references: FUNC-AC-AGENT-DISCIPLINE
---

# ARCH-AC-AGENT-DISCIPLINE - Agent Execution Discipline

## Overview

Agent execution discipline is a cross-cutting layer applied during assignment planning, session context assembly, implementation reporting, and quality review. It creates an execution contract for each unit of work, injects that contract into the session, and checks the resulting changes against the contract before promotion.

## Data Model

**ExecutionContract** represents the disciplined interpretation of a work assignment. It contains: the work request identifier, assigned specification identifiers, expected artifact locations, assumptions, ambiguities, non-goals, success criteria, verification commands, and a change-size expectation.

**Assumption** records a statement the Builder believes is true, the source that supports it, and whether it is confirmed by a governing specification or merely inferred.

**Ambiguity** records an unresolved decision, the specification layer where it was discovered, the parent layers already checked, and the recommended status if it cannot be resolved.

**NonGoal** records an adjacent behavior or cleanup that is intentionally out of scope for the assignment.

**SuccessCriterion** records an observable outcome, the artifact or behavior it concerns, and the verification signal expected to demonstrate it.

**ScopeLedgerEntry** records a changed artifact, the reason it was changed, the related success criterion or specification, and whether it was part of the expected artifact set.

**DisciplineFinding** records a review issue related to execution discipline. Finding types are: unresolved-assumption, hidden-ambiguity, speculative-complexity, unrelated-change, missing-verification, and oversized-change.

**DisciplineReport** records the review outcome for a completed unit: the execution contract, scope ledger, findings, and whether discipline review passed.

## API Contract

**Prepare execution contract** - Called by the Implementation Coordinator before starting a Builder session. Request: unit assignment, governing specification content, expected artifacts, known pitfalls, and verification command. Response: an ExecutionContract. The contract is stored with the unit state and injected into the Builder session context.

**Report execution outcome** - Called by the Builder session through its final status report. Request: exit status, scope ledger entries, verification evidence mapped to success criteria, and any remaining concerns. Response: accepted report or structured report error.

**Evaluate discipline** - Called by the Validation Service during quality review. Request: implementation diff, full changed-artifact list, ExecutionContract, Builder report, and governing specification content. Response: DisciplineReport with structured findings.

**Store behavioral learning input** - Called after review completes when discipline findings are confirmed. Request: DisciplineFindings with affected artifact locations and source work request. Response: acknowledgment that findings were passed to the learning system.

## System Boundaries

- Implementation Coordinator OWNS execution contract creation, storage with unit state, and injection into Builder context.
- Builder sessions OWN execution reports and scope ledger entries for the artifacts they changed.
- Validation Service OWNS discipline evaluation during quality review and decides whether findings block promotion.
- Knowledge Service OWNS persistence and future injection of repeated behavioral findings.
- Daemon Control Plane routes unresolved ambiguity, blocked status, and repeated discipline failures to the existing pipeline states.

## Event Flows

**Assignment preparation flow**
1. Implementation Coordinator receives a unit assignment with governing specifications and expected artifacts.
2. It builds an ExecutionContract from the assignment, specification content, known pitfalls, and verification command.
3. It includes the contract in the Builder session context before implementation begins.
4. If the contract contains unresolved ambiguities that cannot be safely deferred, the unit starts with a context-needs-review status instead of implementation.

**Implementation flow**
1. Builder reads the ExecutionContract before editing.
2. Builder writes or selects verification for the success criteria.
3. Builder implements only the behavior needed for the success criteria.
4. Builder records every changed artifact in a scope ledger.
5. Builder reports verification evidence mapped to each success criterion before completion.

**Quality review flow**
1. Validation Service starts quality review after deterministic checks and specification compliance review.
2. The reviewer receives the ExecutionContract, changed-artifact list, implementation diff, and Builder report.
3. The reviewer evaluates discipline findings: unresolved assumptions, hidden ambiguity, speculative complexity, unrelated changes, missing verification, and oversized changes.
4. Blocking findings enter the normal fix cycle. Non-blocking findings can still become learning input.

**Learning feedback flow**
1. Confirmed discipline findings are converted into behavioral observations with affected artifact locations.
2. Knowledge Service stores or deduplicates the observations.
3. Future assignments touching the same areas receive relevant behavioral observations with their known pitfalls.

## Error Handling

**Missing execution contract:** Treat as a quality gate failure. The work cannot be promoted until the contract is reconstructed or the assignment is re-run.

**Incomplete Builder report:** Treat as a completed-with-concerns result when verification passed but discipline evidence is incomplete; otherwise fail the quality gate.

**Out-of-scope artifact change:** If the changed artifact cannot be traced to the assignment, specification, or verification, fail quality review and route to a fix cycle.

**Speculative complexity:** If a reviewer identifies abstractions, configuration, or optional behavior not required by the current specification, fail quality review unless the Builder can trace it to a governing specification.

**Unresolved ambiguity after parent-layer read:** Route to needs-context or blocked according to severity. Do not continue with implementation based on a guess.

**Repeated discipline failure:** After configured review attempts, escalate through the existing stuck path with the discipline findings included in the report.
