---
id: FUNC-AC-AGENT-DISCIPLINE
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---

# FUNC-AC-AGENT-DISCIPLINE - Agent Execution Discipline

## Problem Statement

Autonomous implementation work fails expensively when an agent silently assumes intent, expands scope, adds speculative flexibility, or reports success without a clear verification target. The system needs a standard execution discipline that makes assumptions visible, keeps work bounded to the requested outcome, and turns each assignment into observable success criteria before implementation begins.

## Actors

- **Operator** - reviews escalations and approves permanent instruction changes
- **Spec Author** - provides governing specifications and clarifies gaps when needed
- **Builder** - performs implementation or fix work from assigned context
- **Reviewer** - independently checks whether the delivered work stayed within scope and met the stated goal

## Behavior

**Scenario: Execution contract before implementation**
- Given a Builder receives a work assignment and governing specifications
- When the Builder prepares to work
- Then the Builder records assumptions, ambiguities, non-goals, expected artifacts, and success criteria before modifying artifacts

**Scenario: Ambiguity escalation**
- Given the governing specifications leave a decision unresolved
- When the Builder cannot resolve the decision by reading the parent specification chain
- Then the Builder reports that more context is needed instead of choosing silently

**Scenario: Minimal sufficient solution**
- Given multiple approaches can satisfy the same specification
- When the Builder selects an approach
- Then the Builder chooses the simplest approach that satisfies the current specification without adding future-facing features

**Scenario: Scoped changes**
- Given a Builder has expected artifacts and a stated assignment
- When the Builder changes artifacts
- Then each changed artifact traces to the assignment, the governing specifications, or a required verification artifact

**Scenario: Verification-driven completion**
- Given an implementation unit has success criteria
- When the Builder reports completion
- Then the report identifies which verification demonstrated each success criterion

**Scenario: Independent discipline review**
- Given an implementation passes deterministic checks
- When quality review runs
- Then the Reviewer checks for hidden assumptions, speculative complexity, unrelated changes, and missing success-criteria evidence

**Scenario: Behavioral findings become learning input**
- Given review identifies repeated scope drift, over-complexity, or unresolved assumptions
- When the work is complete
- Then the finding is captured as learning input for future assignments in the affected artifact areas

## Success Criteria

- Implementation plans contain explicit assumptions, ambiguities, non-goals, expected artifacts, and success criteria
- Builders escalate unresolved ambiguity instead of guessing
- Quality review flags unrelated artifact changes and speculative implementation complexity
- Completed work reports verification evidence for each success criterion
- Repeated behavioral mistakes are available as learning input for future work

## Constraints

- Execution discipline never overrides governing specifications; higher specification layers remain authoritative
- Builders do not inspect holdout scenarios while defining success criteria
- Permanent changes to operating instructions still require Operator approval
- The discipline must not require interactive clarification during autonomous execution; unresolved ambiguity routes to an explicit non-success status
- Reviewers evaluate only artifacts and behavior relevant to the assignment, not unrelated pre-existing defects
